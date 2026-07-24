(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN_V2__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN_V2__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const TIMEDTEXT_RE = /^https:\/\/www\.youtube\.com\/api\/timedtext/i;
  let currentSelection = { enabled: null, baseLang: '', translatedLang: '', selectedLang: '', key: 'unknown' };

  function normalizeLang(value) {
    const raw = typeof value === 'string'
      ? value
      : value?.languageCode || value?.lang || value?.id || value?.code || '';
    return String(raw || '').trim().replace(/^a\./i, '').replace(/^\./, '').replace(/_/g, '-').toLowerCase();
  }

  function isTimedTextUrl(input) {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input || '');
      return TIMEDTEXT_RE.test(url);
    } catch {
      return false;
    }
  }

  function readOption(player, group, name) {
    try { return player?.getOption?.(group, name) ?? null; } catch { return null; }
  }

  function readSelection() {
    const player = document.getElementById('movie_player');
    const track = readOption(player, 'captions', 'track') || {};
    const translation = readOption(player, 'captions', 'translationLanguage')
      || track.translationLanguage || track.translation_language || {};
    const baseLang = normalizeLang(track.languageCode || track.language_code || track.lang || track.vssId || track.vss_id);
    const translatedLang = normalizeLang(translation);
    const selectedLang = translatedLang || baseLang;
    const button = document.querySelector('.ytp-subtitles-button');
    const pressed = button?.getAttribute('aria-pressed');
    const enabled = pressed === 'true' ? true : pressed === 'false' ? false : Boolean(selectedLang);
    return {
      enabled,
      baseLang,
      translatedLang,
      selectedLang,
      key: `${enabled ? 'on' : 'off'}:${baseLang || '-'}:${translatedLang || '-'}`
    };
  }

  function publishSelection(force = false) {
    const next = readSelection();
    if (force || next.key !== currentSelection.key) {
      currentSelection = next;
      window.postMessage({
        source: SOURCE,
        type: 'YOUTUBE_CAPTION_SELECTION_CHANGED',
        payload: { ...next, pageUrl: location.href, changedAt: Date.now() }
      }, '*');
    } else {
      currentSelection = next;
    }
    return currentSelection;
  }

  function metadataFrom(url, body) {
    let u;
    try { u = new URL(url, location.href); } catch { u = new URL(location.href); }
    const trimmed = String(body || '').trim();
    const originalLang = normalizeLang(u.searchParams.get('lang') || '');
    const requestedTlang = normalizeLang(u.searchParams.get('tlang') || '');
    const selectedLang = requestedTlang || originalLang;
    return {
      url: String(url),
      videoId: u.searchParams.get('v') || new URL(location.href).searchParams.get('v') || '',
      rawLang: selectedLang,
      originalLang,
      requestedTlang,
      tlang: null,
      selectedLang,
      kind: u.searchParams.get('kind') || null,
      name: u.searchParams.get('name') || null,
      format: trimmed.startsWith('<') ? 'xml' : 'json3',
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

  function matchesSelection(metadata, selection) {
    if (selection.enabled === false) return false;
    if (!selection.selectedLang) return true;
    if (selection.translatedLang) {
      return Boolean(metadata.requestedTlang) && sameLanguage(metadata.requestedTlang, selection.translatedLang);
    }
    if (metadata.requestedTlang) return false;
    return !selection.baseLang || sameLanguage(metadata.originalLang, selection.baseLang);
  }

  function emit(metadata) {
    window.postMessage({ source: SOURCE, type: 'YOUTUBE_TIMEDTEXT_RESPONSE', payload: metadata }, '*');
  }

  function processTimedText(url, body) {
    if (!body || typeof body !== 'string') return;
    const metadata = metadataFrom(url, body);
    if (matchesSelection(metadata, publishSelection(false))) {
      emit(metadata);
      return;
    }
    setTimeout(() => {
      if (matchesSelection(metadata, publishSelection(false))) emit(metadata);
    }, 140);
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function filteredFetch(input, init) {
      const response = await nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && isTimedTextUrl(url) && response?.ok) {
          response.clone().text().then((body) => processTimedText(url, body)).catch(() => {});
        }
      } catch {}
      return response;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    XHR.prototype.open = function filteredOpen(method, url) {
      this.__ytortTimedTextUrl = url;
      return nativeOpen.apply(this, arguments);
    };
    XHR.prototype.send = function filteredSend() {
      try {
        this.addEventListener('load', function onLoad() {
          try {
            const url = this.__ytortTimedTextUrl;
            if (!url || !isTimedTextUrl(url) || this.status < 200 || this.status >= 300) return;
            if (this.responseType && this.responseType !== 'text') return;
            processTimedText(url, this.responseText);
          } catch {}
        });
      } catch {}
      return nativeSend.apply(this, arguments);
    };
  }

  const refresh = () => publishSelection(false);
  document.addEventListener('yt-player-updated', refresh, true);
  document.addEventListener('yt-navigate-finish', () => publishSelection(true), true);
  document.addEventListener('click', (event) => {
    if (event.target?.closest?.('.ytp-subtitles-button, .ytp-settings-menu, .ytp-menuitem')) {
      setTimeout(refresh, 0);
      setTimeout(refresh, 180);
      setTimeout(refresh, 500);
    }
  }, true);
  setInterval(refresh, 250);
  publishSelection(true);
  window.postMessage({ source: SOURCE, type: 'MAIN_READY', payload: { pageUrl: location.href } }, '*');
})();
