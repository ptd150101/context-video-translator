(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_MAIN__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const TIMEDTEXT_RE = /^https:\/\/www\.youtube\.com\/api\/timedtext/i;

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

  function postTimedText(url, body) {
    if (!body || typeof body !== 'string') return;
    window.postMessage({
      source: SOURCE,
      type: 'YOUTUBE_TIMEDTEXT_RESPONSE',
      payload: extractMetadata(url, body)
    }, '*');
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
            const body = this.responseText;
            postTimedText(url, body);
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, arguments);
    };
  }

  window.postMessage({ source: SOURCE, type: 'MAIN_READY', payload: { pageUrl: location.href } }, '*');
})();
