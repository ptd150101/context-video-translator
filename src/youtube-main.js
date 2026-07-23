(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const TIMEDTEXT_RE = /^https:\/\/www\.youtube\.com\/api\/timedtext/i;
  const lockedTrackByVideo = new Map();
  const originalTrackFetches = new Map();

  function isTimedTextUrl(input) {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input || '');
      return TIMEDTEXT_RE.test(url);
    } catch {
      return false;
    }
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
    return {
      url: String(url),
      videoId: u.searchParams.get('v') || new URL(location.href).searchParams.get('v') || '',
      rawLang: u.searchParams.get('lang') || '',
      tlang: u.searchParams.get('tlang') || null,
      kind: u.searchParams.get('kind') || null,
      name: u.searchParams.get('name') || null,
      format,
      body,
      capturedAt: Date.now(),
      pageUrl: location.href
    };
  }

  function getTrackKey(metadata) {
    return [metadata.rawLang || 'unknown', metadata.kind || '', metadata.name || ''].join(':');
  }

  function reserveTrack(metadata) {
    const videoId = metadata.videoId || '';
    if (!videoId) return { accepted: true, newlyLocked: false };
    const trackKey = getTrackKey(metadata);
    const lockedTrack = lockedTrackByVideo.get(videoId);
    if (lockedTrack && lockedTrack !== trackKey) return { accepted: false, newlyLocked: false };
    if (!lockedTrack) {
      lockedTrackByVideo.set(videoId, trackKey);
      return { accepted: true, newlyLocked: true };
    }
    return { accepted: true, newlyLocked: false };
  }

  function releaseTrack(metadata, reservation) {
    if (!reservation?.newlyLocked || !metadata.videoId) return;
    const trackKey = getTrackKey(metadata);
    if (lockedTrackByVideo.get(metadata.videoId) === trackKey) lockedTrackByVideo.delete(metadata.videoId);
  }

  function emitTimedText(metadata) {
    window.postMessage({
      source: SOURCE,
      type: 'YOUTUBE_TIMEDTEXT_RESPONSE',
      payload: metadata
    }, '*');
  }

  async function fetchOriginalTrack(metadata) {
    const originalUrl = new URL(metadata.url, location.href);
    originalUrl.searchParams.delete('tlang');
    const key = originalUrl.toString();
    if (!originalTrackFetches.has(key)) {
      originalTrackFetches.set(key, (async () => {
        const response = await originalFetch(key, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })().finally(() => originalTrackFetches.delete(key)));
    }
    const body = await originalTrackFetches.get(key);
    return extractMetadata(key, body);
  }

  async function postTimedText(url, body) {
    if (!body || typeof body !== 'string') return;
    const metadata = extractMetadata(url, body);
    const reservation = reserveTrack(metadata);
    if (!reservation.accepted) return;

    if (!metadata.tlang) {
      emitTimedText(metadata);
      return;
    }

    try {
      // A `tlang` response contains YouTube's translated captions, not the
      // video's source-language track. Forward only the original track so a
      // remembered Japanese translation cannot replace Korean source captions.
      emitTimedText(await fetchOriginalTrack(metadata));
    } catch {
      // Never expose a translated `tlang` body as the source subtitle. Release
      // a new lock so a later valid original track can still be accepted.
      releaseTrack(metadata, reservation);
    }
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

  window.postMessage({ source: SOURCE, type: 'MAIN_READY', payload: { pageUrl: location.href } }, '*');
})();
