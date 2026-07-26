(() => {
  if (window.__YTORT_DIAGNOSTICS_RECORDER__) return;
  window.__YTORT_DIAGNOSTICS_RECORDER__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const GUARDED = '__ytortCaptionEventGuarded';
  const MAX_RECORDS = 320;
  const MAX_PAYLOADS = 8;
  const records = [];
  const payloads = [];
  let sequence = 0;
  let lastDomSignature = '';
  let domTimer = 0;
  let lastPlayerSelection = '';

  const nowIso = () => new Date().toISOString();

  function clampText(value, max = 12000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function hasKana(value) {
    return /[\u3040-\u30ff]/.test(String(value || ''));
  }

  function hasHangul(value) {
    return /[\uac00-\ud7af]/.test(String(value || ''));
  }

  function safeValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (depth >= 4) return '[max-depth]';
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => safeValue(item, depth + 1, seen));
    const out = {};
    for (const key of Object.keys(value).slice(0, 80)) {
      try { out[key] = safeValue(value[key], depth + 1, seen); } catch { out[key] = '[unreadable]'; }
    }
    return out;
  }

  function pushRecord(type, data = {}) {
    records.push({
      seq: ++sequence,
      at: nowIso(),
      perfMs: Math.round(performance.now() * 10) / 10,
      type,
      pageUrl: location.href,
      ...safeValue(data)
    });
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  }

  function eventText(event) {
    return (Array.isArray(event?.segs) ? event.segs : [])
      .map((seg) => String(seg?.utf8 || ''))
      .join('');
  }

  function analyzeJson3(body) {
    const result = {
      parseOk: false,
      eventCount: 0,
      mixedEventIndexes: [],
      hangulOnlyIndexes: [],
      japaneseIndexes: [],
      overlappingMixedPairs: [],
      eventPreview: []
    };
    try {
      const data = JSON.parse(String(body || ''));
      const events = Array.isArray(data?.events) ? data.events : [];
      result.parseOk = true;
      result.eventCount = events.length;
      const timed = events.map((event, index) => {
        const text = eventText(event);
        const start = Number(event?.tStartMs || 0);
        const duration = Math.max(1, Number(event?.dDurationMs || 0) || 2500);
        const kana = hasKana(text);
        const hangul = hasHangul(text);
        if (kana && hangul) result.mixedEventIndexes.push(index);
        else if (hangul) result.hangulOnlyIndexes.push(index);
        if (kana) result.japaneseIndexes.push(index);
        if (result.eventPreview.length < 45 && normalizeText(text)) {
          result.eventPreview.push({
            index,
            tStartMs: start,
            dDurationMs: duration,
            endMs: start + duration,
            id: event?.id ?? null,
            wWinId: event?.wWinId ?? null,
            wpWinPosId: event?.wpWinPosId ?? null,
            segCount: Array.isArray(event?.segs) ? event.segs.length : 0,
            text: clampText(text, 1600),
            hasKana: kana,
            hasHangul: hangul
          });
        }
        return { index, start, end: start + duration, duration, text, kana, hangul };
      });
      for (let i = 0; i < timed.length; i += 1) {
        const left = timed[i];
        if (!left.text) continue;
        for (let j = i + 1; j < timed.length; j += 1) {
          const right = timed[j];
          if (right.start > left.end + 1000) break;
          const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
          const ratio = overlap / Math.max(1, Math.min(left.duration, right.duration));
          if (ratio >= 0.45 && ((left.hangul && right.kana) || (left.kana && right.hangul))) {
            result.overlappingMixedPairs.push({ left: left.index, right: right.index, overlapRatio: Math.round(ratio * 1000) / 1000 });
            if (result.overlappingMixedPairs.length >= 30) break;
          }
        }
        if (result.overlappingMixedPairs.length >= 30) break;
      }
    } catch (error) {
      result.error = String(error?.message || error);
    }
    return result;
  }

  function recordTimedText(payload = {}) {
    const body = String(payload.body || '');
    const phase = payload[GUARDED] ? 'guarded' : 'raw';
    const analysis = body.trimStart().startsWith('{') ? analyzeJson3(body) : { parseOk: false, format: payload.format || 'unknown' };
    const item = {
      id: `${Date.now()}-${sequence + 1}-${phase}`,
      at: nowIso(),
      phase,
      meta: {
        url: payload.url || '',
        videoId: payload.videoId || '',
        rawLang: payload.rawLang || '',
        originalLang: payload.originalLang || '',
        requestedTlang: payload.requestedTlang || '',
        selectedLang: payload.selectedLang || '',
        tlang: payload.tlang ?? null,
        format: payload.format || '',
        selectionKey: payload.selectionKey || '',
        selectionEpoch: payload.selectionEpoch ?? null,
        capturedAt: payload.capturedAt ?? null
      },
      analysis,
      body
    };
    payloads.push(item);
    if (payloads.length > MAX_PAYLOADS) payloads.splice(0, payloads.length - MAX_PAYLOADS);
    pushRecord('timedtext', {
      payloadId: item.id,
      phase,
      meta: item.meta,
      bodyLength: body.length,
      analysis
    });
  }

  function readPlayerSelection() {
    const player = document.getElementById('movie_player');
    let track = null;
    let translationLanguage = null;
    try { track = player?.getOption?.('captions', 'track') ?? null; } catch {}
    try { translationLanguage = player?.getOption?.('captions', 'translationLanguage') ?? null; } catch {}
    const button = document.querySelector('.ytp-subtitles-button');
    return {
      ariaPressed: button?.getAttribute('aria-pressed') ?? null,
      track: safeValue(track),
      translationLanguage: safeValue(translationLanguage)
    };
  }

  function recordPlayerSelection(force = false) {
    const selection = readPlayerSelection();
    const signature = JSON.stringify(selection);
    if (!force && signature === lastPlayerSelection) return;
    lastPlayerSelection = signature;
    pushRecord('player-selection', selection);
  }

  function captureDomSnapshot(reason = 'mutation') {
    clearTimeout(domTimer);
    domTimer = setTimeout(() => {
      const overlay = document.getElementById('yt-openai-realtime-translator-overlay');
      const original = overlay?.querySelector('.ytort-original');
      const translated = overlay?.querySelector('.ytort-translated');
      const status = overlay?.querySelector('.ytort-status');
      const video = document.querySelector('video');
      const snapshot = {
        reason,
        videoTime: Number.isFinite(video?.currentTime) ? Math.round(video.currentTime * 1000) / 1000 : null,
        overlayPresent: Boolean(overlay),
        originalText: normalizeText(original?.textContent || ''),
        translatedText: normalizeText(translated?.textContent || ''),
        statusText: normalizeText(status?.textContent || ''),
        originalHtml: clampText(original?.innerHTML || '', 14000),
        originalChildren: original ? Array.from(original.childNodes).map((node, index) => ({
          index,
          nodeType: node.nodeType,
          nodeName: node.nodeName,
          className: node.nodeType === 1 ? node.className : '',
          text: clampText(node.textContent || '', 2500)
        })) : []
      };
      const signature = JSON.stringify([snapshot.videoTime, snapshot.originalText, snapshot.translatedText, snapshot.statusText, snapshot.originalHtml]);
      if (signature === lastDomSignature) return;
      lastDomSignature = signature;
      pushRecord('dom', snapshot);
    }, 40);
  }

  function toast(message) {
    const id = 'ytort-debug-toast';
    document.getElementById(id)?.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '2147483647',
      right: '18px',
      top: '18px',
      maxWidth: '420px',
      padding: '10px 14px',
      borderRadius: '8px',
      background: 'rgba(15,23,42,.95)',
      color: '#fff',
      font: '13px/1.4 system-ui,sans-serif',
      boxShadow: '0 8px 30px rgba(0,0,0,.35)'
    });
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function buildExport() {
    return {
      schema: 'ytort-diagnostics-v1',
      exportedAt: nowIso(),
      extensionExpectedVersion: '0.4.9',
      userAgent: navigator.userAgent,
      pageUrl: location.href,
      playerSelection: readPlayerSelection(),
      instructions: 'Reproduce the mixed Japanese/Korean subtitle, then export immediately with Alt+Shift+D.',
      records,
      payloads
    };
  }

  function exportDiagnostics() {
    captureDomSnapshot('manual-export');
    setTimeout(() => {
      const blob = new Blob([JSON.stringify(buildExport(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = url;
      link.download = `ytort-debug-${stamp}.json`;
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(`Đã xuất log: ${records.length} records, ${payloads.length} payloads`);
      console.info('[YTORT Debug] exported diagnostics', { records: records.length, payloads: payloads.length });
    }, 90);
  }

  function clearDiagnostics() {
    records.length = 0;
    payloads.length = 0;
    sequence = 0;
    lastDomSignature = '';
    pushRecord('diagnostics-cleared');
    toast('Đã xóa log YTORT. Hãy tái hiện bug rồi nhấn Alt+Shift+D.');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== SOURCE) return;
    if (data.type === 'YOUTUBE_CAPTION_SELECTION_CHANGED') {
      pushRecord('selection-message', { payload: data.payload || {}, playerSelection: readPlayerSelection() });
      recordPlayerSelection(true);
      captureDomSnapshot('selection-change');
      return;
    }
    if (data.type === 'YOUTUBE_TIMEDTEXT_RESPONSE') {
      recordTimedText(data.payload || {});
      captureDomSnapshot(data.payload?.[GUARDED] ? 'guarded-payload' : 'raw-payload');
      return;
    }
    pushRecord('main-message', { messageType: data.type || '', payload: data.payload || null });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!(event.altKey && event.shiftKey)) return;
    if (event.code === 'KeyD') {
      event.preventDefault();
      event.stopImmediatePropagation();
      exportDiagnostics();
    } else if (event.code === 'KeyC') {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearDiagnostics();
    }
  }, true);

  const observer = new MutationObserver(() => captureDomSnapshot('mutation'));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  setInterval(() => recordPlayerSelection(false), 500);
  pushRecord('diagnostics-started', {
    shortcuts: {
      export: 'Alt+Shift+D',
      clear: 'Alt+Shift+C'
    },
    playerSelection: readPlayerSelection()
  });
  captureDomSnapshot('startup');
  console.info('[YTORT Debug] recorder active. Reproduce the bug and press Alt+Shift+D to export JSON. Alt+Shift+C clears the buffer.');
})();
