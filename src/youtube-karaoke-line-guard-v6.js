(() => {
  if (window.__YTORT_KARAOKE_LINE_GUARD_V6__) return;
  window.__YTORT_KARAOKE_LINE_GUARD_V6__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const GENERIC_CLASS = 'ytort-generic-karaoke';

  let currentSelectionKey = '';
  let cues = [];
  let state = freshState();

  function freshState() {
    return {
      sourceText: '',
      cueKey: '',
      cueStart: NaN,
      progress: 0,
      videoTime: NaN,
      lastMatchedWallTime: 0
    };
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function comparable(value) {
    return normalizeText(value)
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
  }

  function isCjk(text) {
    const compact = String(text || '').replace(/\s/g, '');
    if (!compact) return false;
    const matches = compact.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    return matches.length / compact.length > 0.35;
  }

  function tokensToCues(tokens) {
    const clean = tokens
      .filter((token) => token?.text && Number.isFinite(token.start) && Number.isFinite(token.end))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!clean.length) return [];

    const cjk = isCjk(clean.map((token) => token.text).join(' '));
    const separator = cjk ? '' : ' ';
    const maxLength = cjk ? 46 : 130;
    const terminal = cjk ? /[。！？.!?]$/ : /[.!?]$/;
    const comma = cjk ? /[、，,;:]$/ : /[,;:]$/;
    const output = [];
    let current = [];

    const joined = (extra = null) => normalizeText(
      (extra ? current.concat(extra) : current).map((token) => token.text).join(separator)
    );

    function emit(group = current) {
      if (!group.length) return;
      const text = normalizeText(group.map((token) => token.text).join(separator));
      if (!text) return;
      const start = group[0].start;
      const end = Math.max(group[group.length - 1].end, start + 0.25);
      output.push({
        key: `${start.toFixed(3)}:${end.toFixed(3)}:${comparable(text)}`,
        start,
        end,
        text
      });
    }

    function splitLong() {
      if (current.length <= 1 || joined().length <= maxLength) return;
      let best = -1;
      for (let index = 0; index < current.length - 1; index += 1) {
        if (comma.test(current[index].text)) best = index;
      }
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
    const events = (Array.isArray(data?.events) ? data.events : [])
      .map((event) => ({
        ...event,
        segs: (Array.isArray(event?.segs) ? event.segs : [])
          .filter((segment) => normalizeText(segment?.utf8))
      }))
      .filter((event) => event.segs.length);
    const tokens = [];

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      const eventStartMs = Number(event.tStartMs || 0);
      for (let segmentIndex = 0; segmentIndex < event.segs.length; segmentIndex += 1) {
        const segment = event.segs[segmentIndex];
        const startMs = eventStartMs + Number(segment.tOffsetMs || 0);
        const nextSegment = event.segs[segmentIndex + 1];
        const nextEvent = events[eventIndex + 1];
        let endMs;
        if (nextSegment) {
          endMs = eventStartMs + Number(nextSegment.tOffsetMs || 0);
        } else if (nextEvent) {
          const eventEnd = eventStartMs + Number(event.dDurationMs || 0);
          endMs = event.dDurationMs
            ? Math.min(eventEnd, Number(nextEvent.tStartMs || eventEnd))
            : Number(nextEvent.tStartMs || startMs + 2500);
        } else {
          endMs = eventStartMs + Number(event.dDurationMs || 2500);
        }
        const text = normalizeText(segment.utf8 || '');
        if (!text) continue;
        tokens.push({
          start: startMs / 1000,
          end: Math.max(endMs / 1000, startMs / 1000 + 0.08),
          text
        });
      }
    }
    return tokensToCues(tokens);
  }

  function parseXml(body) {
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const tokens = Array.from(doc.querySelectorAll('text'))
      .map((node) => {
        const start = Number(node.getAttribute('start') || 0);
        const duration = Math.max(0.25, Number(node.getAttribute('dur') || 2.5));
        return {
          start,
          end: start + duration,
          text: normalizeText(node.textContent || '')
        };
      })
      .filter((token) => token.text);
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
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return b.width * b.height - a.width * a.height;
      })[0] || null;
  }

  function cueMatchScore(cue, sourceText, time) {
    const cueText = normalizeText(cue?.text || '');
    const source = normalizeText(sourceText || '');
    if (!cueText || !source) return -Infinity;

    const cueComparable = comparable(cueText);
    const sourceComparable = comparable(source);
    let score = 0;
    if (cueText === source) score += 1000;
    else if (cueComparable && cueComparable === sourceComparable) score += 900;
    else if (cueComparable && sourceComparable && (
      cueComparable.includes(sourceComparable) || sourceComparable.includes(cueComparable)
    )) {
      const smaller = Math.min(cueComparable.length, sourceComparable.length);
      const larger = Math.max(cueComparable.length, sourceComparable.length);
      score += 500 + 300 * (smaller / Math.max(1, larger));
    } else {
      return -Infinity;
    }

    if (time >= cue.start - 0.12 && time <= cue.end + 0.18) score += 250;
    const center = (cue.start + cue.end) / 2;
    score -= Math.min(120, Math.abs(time - center) * 12);
    return score;
  }

  function findCue(sourceText, time) {
    let best = null;
    let bestScore = -Infinity;
    for (const cue of cues) {
      if (cue.start > time + 4) break;
      if (cue.end < time - 4) continue;
      const score = cueMatchScore(cue, sourceText, time);
      if (score > bestScore) {
        best = cue;
        bestScore = score;
      }
    }
    return best;
  }

  function longestSuffixPrefixOverlap(previousText, nextText) {
    const left = Array.from(normalizeText(previousText));
    const right = Array.from(normalizeText(nextText));
    const max = Math.min(left.length, right.length);
    for (let size = max; size > 0; size -= 1) {
      if (left.slice(left.length - size).join('') === right.slice(0, size).join('')) return size;
    }
    return 0;
  }

  function mapPreviousProgress(previousText, previousProgress, nextText) {
    const prev = normalizeText(previousText);
    const next = normalizeText(nextText);
    if (!prev || !next) return 0;
    if (prev === next) return Math.max(0, Math.min(1, previousProgress));

    const prevLength = Math.max(1, Array.from(prev).length);
    const nextLength = Math.max(1, Array.from(next).length);
    const previousCharPosition = Math.max(0, Math.min(prevLength, previousProgress * prevLength));

    // Rolling captions normally append text: "what" -> "what are". Map the
    // already swept prefix into the longer line instead of restarting at zero.
    if (next.startsWith(prev)) {
      return Math.max(0, Math.min(1, previousCharPosition / nextLength));
    }

    // Some tracks replace the line with a shorter prefix during roll-up.
    if (prev.startsWith(next)) {
      return Math.max(0, Math.min(1, previousCharPosition / nextLength));
    }

    // Sliding captions can drop words from the left while retaining a suffix.
    // Preserve the visible swept position inside the overlapping text.
    const overlap = longestSuffixPrefixOverlap(prev, next);
    if (overlap > 0) {
      const overlapStartInPrevious = prevLength - overlap;
      const mappedPosition = Math.max(0, previousCharPosition - overlapStartInPrevious);
      return Math.max(0, Math.min(1, mappedPosition / nextLength));
    }

    return 0;
  }

  function chooseStableProgress(sourceText, cue, candidate, videoTime) {
    const movingForward = !Number.isFinite(state.videoTime) || videoTime >= state.videoTime - 0.12;
    const explicitSeekBack = Number.isFinite(state.videoTime) && videoTime < state.videoTime - 0.35;
    const closeContinuation = Number.isFinite(state.videoTime) && Math.abs(videoTime - state.videoTime) <= 1.35;

    let next = Math.max(0, Math.min(1, candidate));
    if (movingForward && closeContinuation && state.sourceText) {
      const mappedPrevious = mapPreviousProgress(state.sourceText, state.progress, sourceText);
      next = Math.max(mappedPrevious, next);
    }
    if (explicitSeekBack) next = Math.max(0, Math.min(1, candidate));

    state.sourceText = sourceText;
    state.cueKey = cue.key;
    state.cueStart = cue.start;
    state.progress = next;
    state.videoTime = videoTime;
    state.lastMatchedWallTime = performance.now();
    return next;
  }

  function applyLineSweep(wrap, cue, videoTime) {
    const originalEl = wrap.closest('.ytort-original');
    const sourceText = normalizeText(wrap.dataset.sourceText || wrap.textContent || '');
    if (!sourceText || !cue || !originalEl) return;
    const duration = Math.max(0.25, cue.end - cue.start);
    const rawProgress = (videoTime - cue.start) / duration;
    const progress = chooseStableProgress(sourceText, cue, rawProgress, videoTime);
    const pct = `${Math.round(progress * 1000) / 10}%`;

    // Store progress on the persistent original-line element. The generic
    // wrapper is frequently replaced when rolling captions append a word, so a
    // property stored on the wrapper itself visibly flashes back to 0%.
    if (originalEl.style.getPropertyValue('--ytort-persistent-karaoke-progress') !== pct) {
      originalEl.style.setProperty('--ytort-persistent-karaoke-progress', pct);
    }
  }

  function clearLineSweep(wrap, force = false) {
    const originalEl = wrap?.closest?.('.ytort-original');
    if (!originalEl) return;
    // Brief JSON3/event gaps are normal while a rolling caption is updated.
    // Keep the inherited progress through that gap to avoid a one-frame flash.
    if (!force && state.lastMatchedWallTime && performance.now() - state.lastMatchedWallTime < 320) return;
    if (originalEl.style.getPropertyValue('--ytort-persistent-karaoke-progress') !== '0%') {
      originalEl.style.setProperty('--ytort-persistent-karaoke-progress', '0%');
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #${OVERLAY_ID} .ytort-original .${GENERIC_CLASS} {
      --ytort-karaoke-progress: var(--ytort-persistent-karaoke-progress, 0%) !important;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-base {
      color:rgba(255,255,255,.50) !important;
      filter:saturate(.72) brightness(.78) !important;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-active {
      display:block !important;
      color:#fff !important;
      filter:brightness(1.12) saturate(1.08) !important;
      clip-path:inset(0 calc(100% - var(--ytort-karaoke-progress, 0%)) 0 0) !important;
      transition:clip-path 80ms linear !important;
      will-change:clip-path;
      pointer-events:none;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-base .ytort-generic-token {
      /* Match Japanese karaoke: dim the whole base row, not each token box. */
      opacity:1 !important;
      filter:none !important;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-active .ytort-generic-token {
      opacity:1 !important;
      filter:saturate(1.08) brightness(1.12) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const data = event.data;
    if (data.type === 'YOUTUBE_CAPTION_SELECTION_CHANGED') {
      currentSelectionKey = String(data.payload?.key || '');
      cues = [];
      state = freshState();
      document.querySelectorAll(`#${OVERLAY_ID} .ytort-original`).forEach((el) => {
        el.style.setProperty('--ytort-persistent-karaoke-progress', '0%');
      });
      return;
    }
    if (data.type !== 'YOUTUBE_TIMEDTEXT_RESPONSE') return;
    const payload = data.payload || {};
    if (payload.selectionKey && currentSelectionKey && payload.selectionKey !== currentSelectionKey) return;
    const parsed = parsePayload(payload);
    if (parsed.length) cues = parsed;
  });

  function tick() {
    const wrap = document.querySelector(`#${OVERLAY_ID} .${GENERIC_CLASS}`);
    const video = wrap ? findVideo() : null;
    if (wrap && video) {
      const sourceText = normalizeText(wrap.dataset.sourceText || wrap.textContent || '');
      const cue = findCue(sourceText, video.currentTime);
      if (cue) applyLineSweep(wrap, cue, video.currentTime);
      else {
        clearLineSweep(wrap);
        if (Number.isFinite(state.videoTime) && video.currentTime < state.videoTime - 0.2) state = freshState();
      }
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
