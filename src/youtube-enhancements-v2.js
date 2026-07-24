(() => {
  if (window.__YTORT_LANGUAGE_AGNOSTIC_KARAOKE_V2__) return;
  window.__YTORT_LANGUAGE_AGNOSTIC_KARAOKE_V2__ = true;

  const MAIN_SOURCE = 'yt-openai-realtime-translator-main';
  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const GENERIC_CLASS = 'ytort-generic-karaoke';
  const SWITCHING_CLASS = 'ytort-caption-switching';
  const INACTIVE_CLASS = 'ytort-caption-inactive';
  const ROUTINE_STATUS_RE = /(?:waiting\s+(?:for\s+)?(?:youtube\s+)?captions?|waiting.*first.*caption|turn captions on|loaded\s+\d+.*waiting)/i;

  let settings = { studyMode: false, studySpeakingHighlight: true, showOriginal: true };
  let cues = [];
  let currentTrackKey = '';
  let switchTimer = 0;
  let syncQueued = false;

  const style = document.createElement('style');
  style.textContent = `
    html.${SWITCHING_CLASS} #${OVERLAY_ID},
    html.${INACTIVE_CLASS} #${OVERLAY_ID}{display:none!important;visibility:hidden!important}
    #${OVERLAY_ID} .${GENERIC_CLASS}{vertical-align:middle}
    #${OVERLAY_ID} .ytort-generic-token{
      display:inline-block;padding:1px 4px 2px;margin:1px 1.5px;border-radius:6px;
      border:1px solid rgba(255,255,255,.17);line-height:1.12;
      box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 1px 2px rgba(0,0,0,.2);white-space:pre-wrap
    }
    #${OVERLAY_ID} .ytort-generic-token[data-color="0"]{color:#dbeafe;background:rgba(37,99,235,.32);border-color:rgba(96,165,250,.42)}
    #${OVERLAY_ID} .ytort-generic-token[data-color="1"]{color:#fef3c7;background:rgba(202,138,4,.30);border-color:rgba(250,204,21,.38)}
    #${OVERLAY_ID} .ytort-generic-token[data-color="2"]{color:#fce7f3;background:rgba(190,24,93,.28);border-color:rgba(244,114,182,.38)}
    #${OVERLAY_ID} .ytort-generic-token[data-color="3"]{color:#dcfce7;background:rgba(22,163,74,.27);border-color:rgba(74,222,128,.36)}
    #${OVERLAY_ID} .ytort-generic-token[data-color="4"]{color:#ede9fe;background:rgba(109,40,217,.28);border-color:rgba(167,139,250,.38)}
    #${OVERLAY_ID} .ytort-generic-token[data-color="5"]{color:#cffafe;background:rgba(8,145,178,.28);border-color:rgba(34,211,238,.38)}
    #${OVERLAY_ID} .ytort-karaoke-base .ytort-generic-token{opacity:.50;filter:saturate(.55) brightness(.78)}
    #${OVERLAY_ID} .ytort-karaoke-active .ytort-generic-token{opacity:1;filter:saturate(1.08) brightness(1.12)}
    #${OVERLAY_ID} .ytort-generic-space{white-space:pre}
  `;
  (document.head || document.documentElement).appendChild(style);

  function normalizeText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isCJK(text) {
    const compact = String(text || '').replace(/\s/g, '');
    if (!compact) return false;
    const chars = compact.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    return chars.length / compact.length > 0.35;
  }

  function tokensToCues(tokens) {
    const clean = tokens.filter((t) => t?.text && Number.isFinite(t.start) && Number.isFinite(t.end))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (!clean.length) return [];

    const cjk = isCJK(clean.map((t) => t.text).join(' '));
    const separator = cjk ? '' : ' ';
    const maxLength = cjk ? 46 : 130;
    const terminal = cjk ? /[。！？.!?]$/ : /[.!?]$/;
    const comma = cjk ? /[、，,;:]$/ : /[,;:]$/;
    const output = [];
    let current = [];
    const joined = (extra = null) => normalizeText((extra ? current.concat(extra) : current).map((t) => t.text).join(separator));

    function emit(group = current) {
      if (!group.length) return;
      const text = normalizeText(group.map((t) => t.text).join(separator));
      if (!text) return;
      let cursor = 0;
      const timingSegments = group.map((token) => {
        const tokenText = normalizeText(token.text);
        let startChar = text.indexOf(tokenText, cursor);
        if (startChar < 0) startChar = cursor;
        const endChar = Math.min(text.length, startChar + tokenText.length);
        cursor = Math.max(cursor, endChar);
        return { ...token, startChar, endChar };
      });
      output.push({ start: group[0].start, end: Math.max(group[group.length - 1].end, group[0].start + .25), text, timingSegments });
    }

    function splitLong() {
      if (current.length <= 1 || joined().length <= maxLength) return;
      let best = -1;
      for (let i = 0; i < current.length - 1; i += 1) if (comma.test(current[i].text)) best = i;
      if (best < 0) best = Math.floor(current.length / 2) - 1;
      if (best >= 0) {
        emit(current.slice(0, best + 1));
        current = current.slice(best + 1);
      }
    }

    for (const token of clean) {
      if (current.length) {
        const gap = token.start - current[current.length - 1].end;
        if (gap > 1.35) {
          emit(); current = [];
        } else if (joined(token).length > maxLength) {
          splitLong();
          if (joined(token).length > maxLength) { emit(); current = []; }
        }
      }
      current.push(token);
      if (terminal.test(token.text)) { emit(); current = []; }
    }
    emit();
    return output;
  }

  function parsePayload(payload = {}) {
    const body = String(payload.body || '').trim();
    if (!body) return [];
    try {
      if (payload.format === 'xml' || body.startsWith('<')) {
        const doc = new DOMParser().parseFromString(body, 'text/xml');
        if (doc.querySelector('parsererror')) return [];
        return tokensToCues(Array.from(doc.querySelectorAll('text')).map((node) => {
          const start = Number(node.getAttribute('start') || 0);
          const duration = Number(node.getAttribute('dur') || 2.5);
          return { start, end: start + Math.max(duration, .25), text: normalizeText(node.textContent || '') };
        }));
      }

      const data = JSON.parse(body);
      const events = (Array.isArray(data.events) ? data.events : []).map((event) => ({
        ...event,
        segs: (Array.isArray(event.segs) ? event.segs : []).filter((segment) => normalizeText(segment.utf8))
      })).filter((event) => event.segs.length);
      const tokens = [];
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        for (let j = 0; j < event.segs.length; j += 1) {
          const segment = event.segs[j];
          const startMs = Number(event.tStartMs || 0) + Number(segment.tOffsetMs || 0);
          const nextSegment = event.segs[j + 1];
          const nextEvent = events[i + 1];
          let endMs;
          if (nextSegment) endMs = Number(event.tStartMs || 0) + Number(nextSegment.tOffsetMs || 0);
          else if (nextEvent) {
            const eventEnd = Number(event.tStartMs || 0) + Number(event.dDurationMs || 0);
            endMs = event.dDurationMs ? Math.min(eventEnd, Number(nextEvent.tStartMs || eventEnd)) : Number(nextEvent.tStartMs || startMs + 2500);
          } else endMs = Number(event.tStartMs || 0) + Number(event.dDurationMs || 2500);
          const text = normalizeText(segment.utf8);
          if (text) tokens.push({ start: startMs / 1000, end: Math.max(endMs / 1000, startMs / 1000 + .25), text });
        }
      }
      return tokensToCues(tokens);
    } catch {
      return [];
    }
  }

  function findVideo() {
    return Array.from(document.querySelectorAll('video')).filter((v) => v.isConnected)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0] || null;
  }

  function findCue(time) {
    const t = Number(time) || 0;
    for (let i = cues.length - 1; i >= 0; i -= 1) {
      const cue = cues[i];
      if (t >= cue.start - .08 && t <= cue.end + .12) return cue;
      if (cue.end < t - 1) break;
    }
    return null;
  }

  function cueProgress(cue, time) {
    if (!cue) return 0;
    const length = Math.max(1, cue.text.length);
    const segments = Array.isArray(cue.timingSegments) ? cue.timingSegments : [];
    const t = Number(time) || 0;
    if (segments.length >= 2) {
      if (t <= segments[0].start) return 0;
      if (t >= segments[segments.length - 1].end) return 1;
      let segment = segments[0];
      for (const candidate of segments) {
        if (t >= candidate.start && t <= candidate.end) { segment = candidate; break; }
        if (t > candidate.end) segment = candidate;
      }
      const duration = Math.max(.08, segment.end - segment.start);
      const within = Math.max(0, Math.min(1, (t - segment.start) / duration));
      return Math.max(0, Math.min(1, (segment.startChar + (segment.endChar - segment.startChar) * within) / length));
    }
    return Math.max(0, Math.min(1, (t - cue.start) / Math.max(.25, cue.end - cue.start)));
  }

  function segmentText(text) {
    const pieces = [];
    try {
      if (typeof Intl?.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        for (const part of segmenter.segment(text)) pieces.push({ text: part.segment, wordLike: Boolean(part.isWordLike) });
      }
    } catch {}
    if (!pieces.length) {
      const fallback = String(text || '').match(/\s+|[\p{L}\p{N}\p{M}]+|[^\s\p{L}\p{N}\p{M}]+/gu) || [];
      fallback.forEach((part) => pieces.push({ text: part, wordLike: /[\p{L}\p{N}\p{M}]/u.test(part) }));
    }
    return pieces;
  }

  function renderGeneric(text) {
    let index = 0;
    return segmentText(text).map((part) => {
      if (/^\s+$/.test(part.text)) return `<span class="ytort-generic-space">${escapeHtml(part.text)}</span>`;
      if (!part.wordLike && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(part.text)) return escapeHtml(part.text);
      const color = index++ % 6;
      return `<span class="ytort-generic-token" data-color="${color}">${escapeHtml(part.text)}</span>`;
    }).join('');
  }

  function hasJapaneseMarkup(el) {
    return Boolean(el.querySelector('.ytort-study-token:not(.ytort-generic-token), .ytort-study-chunk'));
  }

  function textOutsideGeneric(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`.${GENERIC_CLASS}`).forEach((node) => node.remove());
    return normalizeText(clone.textContent || '');
  }

  function restoreGeneric(el) {
    const wrap = el.querySelector(`.${GENERIC_CLASS}`);
    if (!wrap) return;
    el.textContent = wrap.dataset.sourceText || normalizeText(wrap.querySelector('.ytort-karaoke-base')?.textContent || '');
    el.classList.remove('ytort-study-line', 'ytort-study-clean', 'ytort-study-boxes', 'ytort-karaoke-line');
  }

  function syncOriginal(el) {
    if (!el) return;
    if (!(settings.studyMode && settings.studySpeakingHighlight && settings.showOriginal)) {
      restoreGeneric(el);
      return;
    }

    const generic = el.querySelector(`.${GENERIC_CLASS}`);
    const outside = textOutsideGeneric(el);
    if (hasJapaneseMarkup(el)) {
      if (generic) generic.remove();
      return;
    }
    if (generic && !outside) return;

    const text = outside || (!generic ? normalizeText(el.textContent || '') : '');
    if (!text || ROUTINE_STATUS_RE.test(text)) return;
    const content = renderGeneric(text);
    el.innerHTML = `<span class="ytort-karaoke-wrap ${GENERIC_CLASS}" data-source-text="${escapeHtml(text)}" style="--ytort-karaoke-progress:0%"><span class="ytort-karaoke-base">${content}</span><span class="ytort-karaoke-active" aria-hidden="true">${content}</span></span>`;
    el.classList.add('ytort-study-line', 'ytort-study-clean', 'ytort-karaoke-line');
    el.classList.remove('ytort-study-boxes');
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      document.querySelectorAll(`#${OVERLAY_ID} .ytort-original`).forEach(syncOriginal);
    });
  }

  function tick() {
    const wrap = document.querySelector(`#${OVERLAY_ID} .${GENERIC_CLASS}`);
    if (wrap && !document.documentElement.classList.contains(SWITCHING_CLASS)) {
      const video = findVideo();
      const cue = video ? findCue(video.currentTime) : null;
      const pct = `${Math.round((cue ? cueProgress(cue, video.currentTime) : 0) * 1000) / 10}%`;
      if (wrap.style.getPropertyValue('--ytort-karaoke-progress') !== pct) wrap.style.setProperty('--ytort-karaoke-progress', pct);
    }
    requestAnimationFrame(tick);
  }

  function trackChanged(payload = {}) {
    const nextKey = String(payload.key || `${payload.enabled}:${payload.selectedLang || ''}`);
    const changed = currentTrackKey && nextKey !== currentTrackKey;
    currentTrackKey = nextKey;
    cues = [];
    document.documentElement.classList.toggle(INACTIVE_CLASS, payload.enabled === false);
    if (payload.enabled !== false && changed) {
      document.documentElement.classList.add(SWITCHING_CLASS);
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => document.documentElement.classList.remove(SWITCHING_CLASS), 1800);
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== MAIN_SOURCE) return;
    if (data.type === 'YOUTUBE_CAPTION_SELECTION_CHANGED') {
      trackChanged(data.payload || {});
      return;
    }
    if (data.type === 'YOUTUBE_TIMEDTEXT_RESPONSE') {
      const parsed = parsePayload(data.payload || {});
      if (parsed.length) {
        cues = parsed;
        document.documentElement.classList.remove(SWITCHING_CLASS, INACTIVE_CLASS);
        clearTimeout(switchTimer);
        queueSync();
      }
    }
  });

  new MutationObserver(queueSync).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  try {
    chrome.storage.local.get('settings', (stored) => {
      settings = { ...settings, ...(stored?.settings || {}) };
      queueSync();
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.settings) {
        settings = { ...settings, ...(changes.settings.newValue || {}) };
        queueSync();
      }
    });
  } catch {}

  queueSync();
  requestAnimationFrame(tick);
})();
