(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN_V3__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN_V3__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const TIMEDTEXT_RE = /^https:\/\/www\.youtube\.com\/api\/timedtext/i;
  let currentSelection = { enabled: null, baseLang: '', translatedLang: '', selectedLang: '', key: 'unknown' };
  let selectionEpoch = 0;
  let lastSelectionChangedAt = 0;
  let deliverySequence = 0;

  function normalizeLang(value) {
    const raw = typeof value === 'string'
      ? value
      : value?.languageCode || value?.lang || value?.id || value?.code || '';
    return String(raw || '')
      .trim()
      .replace(/^a\./i, '')
      .replace(/^\./, '')
      .replace(/_/g, '-')
      .toLowerCase();
  }

  function isTimedTextUrl(input) {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input || '');
      return TIMEDTEXT_RE.test(url);
    } catch {
      return false;
    }
  }

  function readPlayerOption(player, group, name) {
    try {
      return player?.getOption?.(group, name) ?? null;
    } catch {
      return null;
    }
  }

  function readCaptionSelection() {
    const player = document.getElementById('movie_player');
    const track = readPlayerOption(player, 'captions', 'track') || {};
    const translation = readPlayerOption(player, 'captions', 'translationLanguage')
      || track.translationLanguage
      || track.translation_language
      || {};

    const baseLang = normalizeLang(
      track.languageCode || track.language_code || track.lang || track.vssId || track.vss_id
    );
    const translatedLang = normalizeLang(translation);
    const selectedLang = translatedLang || baseLang;
    const button = document.querySelector('.ytp-subtitles-button');
    const ariaPressed = button?.getAttribute('aria-pressed');
    const enabled = ariaPressed === 'true'
      ? true
      : ariaPressed === 'false'
        ? false
        : Boolean(selectedLang);

    return {
      enabled,
      baseLang,
      translatedLang,
      selectedLang,
      key: `${enabled ? 'on' : 'off'}:${baseLang || '-'}:${translatedLang || '-'}`
    };
  }

  function publishSelection(force = false) {
    const next = readCaptionSelection();
    const changed = next.key !== currentSelection.key;
    if (force || changed) {
      if (changed) {
        selectionEpoch += 1;
        lastSelectionChangedAt = Date.now();
      }
      currentSelection = next;
      window.postMessage({
        source: SOURCE,
        type: 'YOUTUBE_CAPTION_SELECTION_CHANGED',
        payload: {
          ...next,
          selectionEpoch,
          pageUrl: location.href,
          changedAt: lastSelectionChangedAt || Date.now()
        }
      }, '*');
    } else {
      currentSelection = next;
    }
    return currentSelection;
  }

  function extractMetadata(url, body) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch {
      u = new URL(location.href);
    }
    const bodyTrim = String(body || '').trim();
    let format = 'unknown';
    if (bodyTrim.startsWith('{') || bodyTrim.startsWith('[')) format = 'json3';
    else if (bodyTrim.startsWith('<')) format = 'xml';

    const originalLang = normalizeLang(u.searchParams.get('lang') || '');
    const requestedTlang = normalizeLang(u.searchParams.get('tlang') || '');
    const selectedLang = requestedTlang || originalLang;

    return {
      url: String(url),
      videoId: u.searchParams.get('v') || new URL(location.href).searchParams.get('v') || '',
      rawLang: selectedLang,
      originalLang,
      requestedTlang,
      // Keep this null so the content script uses the selected display track
      // instead of fetching the video's original-language track again.
      tlang: null,
      selectedLang,
      kind: u.searchParams.get('kind') || null,
      name: u.searchParams.get('name') || null,
      format,
      body,
      capturedAt: Date.now(),
      pageUrl: location.href
    };
  }

  function sameLanguage(a, b) {
    const left = normalizeLang(a);
    const right = normalizeLang(b);
    if (!left || !right) return false;
    return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
  }

  function matchesSelectedTrack(metadata, selection) {
    if (selection.enabled === false) return false;
    if (!selection.selectedLang) return true;

    if (selection.translatedLang) {
      return Boolean(metadata.requestedTlang) && sameLanguage(metadata.requestedTlang, selection.translatedLang);
    }

    if (metadata.requestedTlang) return false;
    if (!selection.baseLang) return true;
    return sameLanguage(metadata.originalLang, selection.baseLang);
  }

  function emitTimedText(metadata, selection) {
    window.postMessage({
      source: SOURCE,
      type: 'YOUTUBE_TIMEDTEXT_RESPONSE',
      payload: {
        ...metadata,
        selectionKey: selection.key,
        selectionEpoch
      }
    }, '*');
  }

  function postTimedText(url, body) {
    if (!body || typeof body !== 'string') return;
    const metadata = extractMetadata(url, body);
    const deliveryId = ++deliverySequence;
    let delivered = false;

    const deliverWhenSelected = () => {
      if (delivered || deliveryId > deliverySequence) return;
      const latest = publishSelection(false);
      if (!matchesSelectedTrack(metadata, latest)) return;
      delivered = true;
      emitTimedText(metadata, latest);
    };

    // Do not forward immediately. During Korean <-> Japanese changes YouTube can
    // finish an old background request before its caption option state updates.
    // A short re-check window lets the selected track settle and prevents the
    // previous language from reaching the content renderer.
    setTimeout(deliverWhenSelected, 150);
    setTimeout(deliverWhenSelected, 360);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && isTimedTextUrl(url) && response && response.ok) {
          response.clone().text().then((body) => postTimedText(url, body)).catch(() => {});
        }
      } catch {}
      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__ytOpenAITranslatorUrl = url;
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function patchedSend() {
      try {
        this.addEventListener('load', function onLoad() {
          try {
            const url = this.__ytOpenAITranslatorUrl;
            if (!url || !isTimedTextUrl(url) || this.status < 200 || this.status >= 300) return;
            if (this.responseType && this.responseType !== 'text') return;
            postTimedText(url, this.responseText);
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, arguments);
    };
  }

  const refreshSelection = () => publishSelection(false);
  document.addEventListener('yt-player-updated', refreshSelection, true);
  document.addEventListener('yt-navigate-finish', () => publishSelection(true), true);
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('.ytp-subtitles-button, .ytp-settings-menu, .ytp-menuitem')) {
      setTimeout(refreshSelection, 0);
      setTimeout(refreshSelection, 180);
      setTimeout(refreshSelection, 500);
    }
  }, true);
  setInterval(refreshSelection, 120);

  publishSelection(true);
  window.postMessage({ source: SOURCE, type: 'MAIN_READY', payload: { pageUrl: location.href } }, '*');
})();
