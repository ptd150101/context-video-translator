(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_UDEMY_MAIN__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_UDEMY_MAIN__ = true;

  const SOURCE = 'yt-openai-realtime-translator-udemy-main';
  const CONTENT_SOURCE = 'yt-openai-realtime-translator-content';
  const VTT_URL_RE = /\.(?:vtt|webvtt)(?:$|[?#])/i;
  const CAPTION_HINT_RE = /(caption|subtitle|transcript|webvtt|\.vtt)/i;
  const MAX_JSON_WALK_NODES = 2200;

  function post(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload: { ...payload, pageUrl: location.href, capturedAt: Date.now() } }, '*');
    } catch {}
  }

  function absolutize(url) {
    try {
      return new URL(String(url || ''), location.href).toString();
    } catch {
      return String(url || '');
    }
  }

  function isProbablyVttUrl(url) {
    const s = String(url || '');
    return VTT_URL_RE.test(s) || (CAPTION_HINT_RE.test(s) && /vtt/i.test(s));
  }

  function isBareCaptionFileName(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return false;
    return /^[^/?#]+\.(?:vtt|webvtt)(?:[?#].*)?$/i.test(raw);
  }

  function isLikelyFetchableVttUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw || isBareCaptionFileName(raw)) return false;
    try {
      const url = new URL(raw, location.href);
      if (!/^https?:/i.test(url.protocol)) return false;
      if (!/\.(?:vtt|webvtt)(?:$|[?#])/i.test(url.href)) return false;
      if (url.origin === location.origin && /\/learn\/lecture\/[^/?#]+\.(?:vtt|webvtt)(?:$|[?#])/i.test(url.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function getHeader(headers, name) {
    try {
      if (!headers) return '';
      if (typeof headers.get === 'function') return headers.get(name) || '';
    } catch {}
    return '';
  }

  function extractCaptionCandidates(data, responseUrl = '') {
    const out = [];
    let walked = 0;
    const seen = new WeakSet();

    function addCandidate(obj, path, urlKey = 'url') {
      const url = obj?.[urlKey] || obj?.src || obj?.href || obj?.asset_url;
      if (!url || typeof url !== 'string') return;
      // Do not treat caption labels/file names as fetchable VTT URLs. Udemy
      // lecture JSON includes fields like title/file_name that end in .vtt,
      // but the real signed URL is in caption.url.
      if (!isLikelyFetchableVttUrl(url)) return;
      const joinedPath = path.join('.');
      const candidateUrl = absolutize(url);
      const pathText = `${joinedPath} ${candidateUrl}`;
      if (!isProbablyVttUrl(candidateUrl) && !CAPTION_HINT_RE.test(pathText)) return;
      out.push({
        url: candidateUrl,
        label: obj.label || obj.title || obj.display_name || obj.name || obj.locale || obj.language || obj.srclang || '',
        language: obj.language || obj.locale || obj.locale_id || obj.lang || obj.srclang || obj.iso_code || '',
        kind: obj.kind || obj.type || '',
        source: 'api-json',
        responseUrl,
        path: joinedPath
      });
    }

    function walk(value, path = []) {
      if (!value || walked++ > MAX_JSON_WALK_NODES) return;
      if (typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);

      if (!Array.isArray(value)) {
        for (const key of ['url', 'src', 'href', 'file', 'asset_url']) addCandidate(value, path, key);
      }

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) walk(value[i], path.concat(String(i)));
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === 'string' && isLikelyFetchableVttUrl(child)) {
            out.push({
              url: absolutize(child),
              label: value.label || value.title || value.name || value.locale || value.language || '',
              language: value.language || value.locale || value.locale_id || value.lang || value.srclang || '',
              kind: value.kind || value.type || '',
              source: 'api-json-string',
              responseUrl,
              path: path.concat(key).join('.')
            });
          } else if (child && typeof child === 'object') {
            walk(child, path.concat(key));
          }
        }
      }
    }

    walk(data);
    const deduped = [];
    const seenUrls = new Set();
    for (const item of out) {
      if (!item.url || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      deduped.push(item);
    }
    return deduped;
  }

  function maybePostBody(url, body, contentType = '') {
    if (!body || typeof body !== 'string') return;
    const trim = body.trim();
    const absoluteUrl = absolutize(url);
    if ((trim.startsWith('WEBVTT') || VTT_URL_RE.test(absoluteUrl) || /text\/vtt|webvtt/i.test(contentType)) && !/(?:thumb|sprite)/i.test(absoluteUrl)) {
      post('UDEMY_CAPTION_FILE', {
        url: absoluteUrl,
        body,
        format: 'vtt',
        source: 'network-vtt',
        label: '',
        language: '',
        contentType
      });
      return;
    }
    if (!CAPTION_HINT_RE.test(`${absoluteUrl} ${trim.slice(0, 500)}`)) return;
    if (!(trim.startsWith('{') || trim.startsWith('['))) return;
    try {
      const json = JSON.parse(trim);
      const candidates = extractCaptionCandidates(json, absoluteUrl);
      if (candidates.length) post('UDEMY_CAPTION_CANDIDATES', { candidates, source: 'api-json' });
    } catch {}
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && response && response.ok) {
          const contentType = getHeader(response.headers, 'content-type');
          const urlText = String(url || '');
          if (isProbablyVttUrl(urlText) || CAPTION_HINT_RE.test(`${urlText} ${contentType}`)) {
            response.clone().text().then((body) => maybePostBody(urlText, body, contentType)).catch(() => {});
          }
        }
      } catch {}
      return response;
    };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE || data.type !== 'UDEMY_PAGE_FETCH_TEXT') return;
    const payload = data.payload || {};
    const requestId = payload.requestId || '';
    try {
      const url = absolutize(payload.url || '');
      if (!url) throw new Error('Missing URL');
      const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
      const response = await originalFetch(url, {
        credentials: payload.credentials || 'include',
        headers,
        cache: 'no-store'
      });
      const contentType = getHeader(response.headers, 'content-type');
      const body = await response.text();
      post('UDEMY_PAGE_FETCH_TEXT_RESULT', {
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText || '',
        url: response.url || url,
        body,
        contentType,
        error: response.ok ? '' : `HTTP ${response.status}: ${body.slice(0, 200)}`
      });
      if (response.ok) maybePostBody(response.url || url, body, contentType);
    } catch (err) {
      post('UDEMY_PAGE_FETCH_TEXT_RESULT', {
        requestId,
        ok: false,
        status: 0,
        body: '',
        contentType: '',
        error: err?.message || String(err)
      });
    }
  });

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR && OriginalXHR.prototype) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__ytOpenAITranslatorUdemyUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function patchedSend() {
      try {
        this.addEventListener('load', function onLoad() {
          try {
            const url = this.__ytOpenAITranslatorUdemyUrl;
            if (!url || this.status < 200 || this.status >= 300) return;
            if (this.responseType && this.responseType !== 'text') return;
            const contentType = this.getResponseHeader?.('content-type') || '';
            if (isProbablyVttUrl(url) || CAPTION_HINT_RE.test(`${url} ${contentType}`)) maybePostBody(url, this.responseText, contentType);
          } catch {}
        });
      } catch {}
      return originalSend.apply(this, arguments);
    };
  }

  function scanInitialState() {
    try {
      const scripts = Array.from(document.scripts || []).slice(0, 120);
      for (const script of scripts) {
        const text = script.textContent || '';
        if (!CAPTION_HINT_RE.test(text) || text.length > 2_500_000) continue;
        const matches = text.match(/https?:[^"'\\\s]+(?:\.vtt|webvtt|caption|subtitle)[^"'\\\s]*/ig) || [];
        if (matches.length) {
          const candidates = matches.slice(0, 40).map((url) => ({ url: absolutize(url), label: '', language: '', source: 'initial-script-url' }));
          post('UDEMY_CAPTION_CANDIDATES', { candidates, source: 'initial-script-url' });
        }
      }
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanInitialState, { once: true });
  else setTimeout(scanInitialState, 0);
  setTimeout(scanInitialState, 2500);
  post('UDEMY_MAIN_READY', {});
})();
