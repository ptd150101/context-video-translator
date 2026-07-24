(() => {
  if (window.__YTORT_LANGUAGE_AGNOSTIC_KARAOKE__) return;
  window.__YTORT_LANGUAGE_AGNOSTIC_KARAOKE__ = true;

  const MAIN_SOURCE = 'yt-openai-realtime-translator-main';
  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const ROUTINE_STATUS_RE = /(?:waiting\s+(?:for\s+)?(?:youtube\s+)?captions?|waiting.*first.*caption|turn captions on|loaded\s+\d+.*waiting)/i;

  let settings = {
    studyMode: false,
    studySpeakingHighlight: true,
    showOriginal: true
  };
  let cues = [];
  let fallbackStartedAt = performance.now();
  let fallbackText = '';

  function normalizeText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isCJK(text) {
    const compact = String(text || '').replace(/\s/g, '');
    if (!compact) return false;
    const chars = compact.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    return chars.length / compact.length > 0.35;
  }

  function tokensToCues(tokens) {
    const clean = tokens
      .filter((token) => token?.text && Number.isFinite(token.start) && Number.isFinite(token.end))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    if (!clean.length) return [];

    const cjk = isCJK(clean.map((token) => token.text).join(' '));
    const separator = cjk ? '' : ' ';
    const maxLength = cjk ? 46 : 130;
    const terminal = cjk ? /[。！？.!?]$/ : /[.!?]$/;
    const comma = cjk ? /[、，,;:]$/ : /[,;:]$/;
    const output = [];
    let current = [];

    const joined = (extra = null) => normalizeText((extra ? current.concat(extra) : current).map((token) => token.text).join(separator));

    function emit(group = current) {
      if (!group.length) return;
      const text = normalizeText(group.map((token) => token.text).join(separator));
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
      output.push({
        start: group[0].start,
        end: Math.max(group[group.length - 1].end, group[0].start + 0.25),
        text,
        timingSegments
      });
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
          emit();
          current = [];
        } else if (joined(token).length > maxLength) {
          splitLong();
          if (joined(token).length > maxLength) {
            emit();
            current = [];
          }
        }
      }
      current.push(token);
      if (terminal.test(token.text)) {
        emit();
        current = [];
      }
    }
    emit();
    return output;
  }

  function parseJson3(body) {
    const data = JSON.parse(body);
    const events = (Array.isArray(data.events) ? data.events : [])
      .map((event) => ({
        ...event,
        segs: (Array.isArray(event.segs) ? event.segs : []).filter((segment) => normalizeText(segment.utf8))
      }))
      .filter((event) => event.segs.length);
    const tokens = [];

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      for (let j = 0; j < event.segs.length; j += 1) {
        const segment = event.segs[j];
        const startMs = Number(event.tStartMs || 0) + Number(segment.tOffsetMs || 0);
        const nextSegment = event.segs[j + 1];
        const nextEvent = events[i + 1];
        let endMs;
        if (nextSegment) {
          endMs = Number(event.tStartMs || 0) + Number(nextSegment.tOffsetMs || 0);
        } else if (nextEvent) {
          const eventEnd = Number(event.tStartMs || 0) + Number(event.dDurationMs || 0);
          endMs = event.dDurationMs
            ? Math.min(eventEnd, Number(nextEvent.tStartMs || eventEnd))
            : Number(nextEvent.tStartMs || startMs + 2500);
        } else {
          endMs = Number(event.tStartMs || 0) + Number(event.dDurationMs || 2500);
        }
        const text = normalizeText(segment.utf8);
        if (text) tokens.push({ start: startMs / 1000, end: Math.max(endMs / 1000, startMs / 1000 + 0.25), text });
      }
    }
    return tokensToCues(tokens);
  }

  function parseXml(body) {
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const tokens = Array.from(doc.querySelectorAll('text')).map((node) => {
      const start = Number(node.getAttribute('start') || 0);
      const duration = Number(node.getAttribute('dur') || 2.5);
      return { start, end: start + Math.max(duration, 0.25), text: normalizeText(node.textContent || '') };
    });
    return tokensToCues(tokens);
  }

  function parsePayload(payload = {}) {
    const body = String(payload.body || '').trim();
    if (!body) return [];
    try {
      if (payload.format === 'json3' || body.startsWith('{') || body.startsWith('[')) return parseJson3(body);
      if (payload.format === 'xml' || body.startsWith('<')) return parseXml(body);
    } catch {}
    return [];
  }

  function findVideo() {
    return Array.from(document.querySelectorAll('video'))
      .filter((video) => video.isConnected)
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
      if (t >= cue.start - 0.08 && t <= cue.end + 0.12) return cue;
      if (cue.end < t - 1) break;
    }
    return null;
  }

  function cueProgress(cue, time) {
    if (!cue) return 0;
    const textLength = Math.max(1, cue.text.length);
    const segments = Array.isArray(cue.timingSegments) ? cue.timingSegments : [];
    const t = Number(time) || 0;
    if (segments.length >= 2) {
      if (t <= segments[0].start) return 0;
      if (t >= segments[segments.length - 1].end) return 1;
      let segment = segments[0];
      for (const candidate of segments) {
        if (t >= candidate.start && t <= candidate.end) {
          segment = candidate;
          break;
        }
        if (t > candidate.end) segment = candidate;
      }
      const duration = Math.max(0.08, segment.end - segment.start);
      const within = Math.max(0, Math.min(1, (t - segment.start) / duration));
      return Math.max(0, Math.min(1, (segment.startChar + (segment.endChar - segment.startChar) * within) / textLength));
    }
    return Math.max(0, Math.min(1, (t - cue.start) / Math.max(0.25, cue.end - cue.start)));
  }

  function suppressRoutineStatus(overlay, originalEl, translatedEl) {
    const original = normalizeText(originalEl?.textContent || '');
    const status = normalizeText(translatedEl?.textContent || '');
    if (!original && status && ROUTINE_STATUS_RE.test(status)) {
      overlay.style.display = 'none';
      return true;
    }
    return false;
  }

  function ensureGenericKaraoke(originalEl) {
    if (!settings.studyMode || !settings.studySpeakingHighlight || !settings.showOriginal) return null;
    const existing = originalEl.querySelector('.ytort-karaoke-wrap');
    if (existing) return existing.dataset.ytortGeneric === '1' ? existing : null;

    const text = normalizeText(originalEl.textContent || '');
    if (!text) return null;
    fallbackStartedAt = performance.now();
    fallbackText = text;

    const wrap = document.createElement('span');
    wrap.className = 'ytort-karaoke-wrap';
    wrap.dataset.ytortGeneric = '1';
    wrap.style.setProperty('--ytort-karaoke-progress', '0%');
    const base = document.createElement('span');
    base.className = 'ytort-karaoke-base';
    base.textContent = text;
    const active = document.createElement('span');
    active.className = 'ytort-karaoke-active';
    active.setAttribute('aria-hidden', 'true');
    active.textContent = text;
    wrap.append(base, active);

    originalEl.textContent = '';
    originalEl.appendChild(wrap);
    originalEl.classList.add('ytort-study-line', 'ytort-study-clean', 'ytort-karaoke-line');
    originalEl.classList.remove('ytort-study-boxes');
    return wrap;
  }

  function tick() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      const originalEl = overlay.querySelector('.ytort-original');
      const translatedEl = overlay.querySelector('.ytort-translated');
      if (originalEl && translatedEl && !suppressRoutineStatus(overlay, originalEl, translatedEl)) {
        const wrap = ensureGenericKaraoke(originalEl);
        if (wrap) {
          const video = findVideo();
          const cue = video ? findCue(video.currentTime) : null;
          const displayed = normalizeText(wrap.querySelector('.ytort-karaoke-base')?.textContent || '');
          let progress;
          if (cue && (!displayed || normalizeText(cue.text) === displayed)) {
            progress = cueProgress(cue, video.currentTime);
          } else {
            if (displayed !== fallbackText) {
              fallbackText = displayed;
              fallbackStartedAt = performance.now();
            }
            progress = Math.max(0, Math.min(1, (performance.now() - fallbackStartedAt) / 2500));
          }
          wrap.style.setProperty('--ytort-karaoke-progress', `${Math.round(progress * 1000) / 10}%`);
        }
      }
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== MAIN_SOURCE || data?.type !== 'YOUTUBE_TIMEDTEXT_RESPONSE') return;
    const parsed = parsePayload(data.payload || {});
    if (parsed.length) cues = parsed;
  });

  try {
    chrome.storage.local.get('settings', (stored) => {
      settings = { ...settings, ...(stored?.settings || {}) };
    });
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.settings) settings = { ...settings, ...(changes.settings.newValue || {}) };
    });
  } catch {}

  requestAnimationFrame(tick);
})();
