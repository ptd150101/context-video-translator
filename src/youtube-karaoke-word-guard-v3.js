(() => {
  if (window.__YTORT_KARAOKE_WORD_GUARD_V3__) return;
  window.__YTORT_KARAOKE_WORD_GUARD_V3__ = true;

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
      progress: 0,
      videoTime: NaN
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

  function ensureTokenLayers(token) {
    const existingBase = token.querySelector(':scope > .ytort-word-sweep-base');
    const existingActive = token.querySelector(':scope > .ytort-word-sweep-active');
    if (token.dataset.ytortWordSweepReady === '1' && existingBase && existingActive) {
      return normalizeText(token.dataset.ytortWordText || existingBase.textContent || '');
    }

    const text = normalizeText(token.dataset.ytortWordText || token.textContent || '');
    token.dataset.ytortWordText = text;
    token.dataset.ytortWordSweepReady = '1';

    const base = document.createElement('span');
    base.className = 'ytort-word-sweep-base';
    base.textContent = text;

    const active = document.createElement('span');
    active.className = 'ytort-word-sweep-active';
    active.textContent = text;
    active.setAttribute('aria-hidden', 'true');

    token.replaceChildren(base, active);
    token.style.setProperty('--ytort-word-progress', '0%');
    return text;
  }

  function tokenRanges(wrap) {
    const sourceText = normalizeText(wrap.dataset.sourceText || wrap.textContent || '');
    const nodes = Array.from(wrap.querySelectorAll('.ytort-karaoke-base .ytort-generic-token'));
    return {
      sourceText,
      tokens: nodes.map((token, index) => {
        const text = ensureTokenLayers(token);
        const graphemeCount = Array.from(text).length;
        const weight = Math.max(1, Math.pow(Math.max(1, graphemeCount), 0.72));
        return { token, index, text, weight };
      })
    };
  }

  function weightedTokenPosition(tokens, progress) {
    if (!tokens.length) return { index: -1, localProgress: 0 };
    const clamped = Math.max(0, Math.min(0.999999, progress));
    const total = tokens.reduce((sum, token) => sum + token.weight, 0);
    const target = clamped * Math.max(1, total);
    let cursor = 0;

    for (const token of tokens) {
      const start = cursor;
      const end = cursor + token.weight;
      if (target < end) {
        return {
          index: token.index,
          localProgress: Math.max(0, Math.min(1, (target - start) / Math.max(0.0001, token.weight)))
        };
      }
      cursor = end;
    }

    return { index: tokens[tokens.length - 1].index, localProgress: 1 };
  }

  function chooseStableProgress(sourceText, cue, candidate, videoTime) {
    const movingForward = !Number.isFinite(state.videoTime) || videoTime >= state.videoTime - 0.12;
    const explicitSeekBack = Number.isFinite(state.videoTime) && videoTime < state.videoTime - 0.35;
    const sameText = state.sourceText === sourceText;
    const sameCue = state.cueKey === cue.key;

    let next = Math.max(0, Math.min(1, candidate));
    if (movingForward && sameText && sameCue) next = Math.max(state.progress, next);
    if (explicitSeekBack) next = Math.max(0, Math.min(1, candidate));

    state.sourceText = sourceText;
    state.cueKey = cue.key;
    state.progress = next;
    state.videoTime = videoTime;
    return next;
  }

  function applyWordSweep(wrap, cue, videoTime) {
    const { sourceText, tokens } = tokenRanges(wrap);
    if (!tokens.length || !cue) return;

    const duration = Math.max(0.25, cue.end - cue.start);
    const rawProgress = (videoTime - cue.start) / duration;
    const progress = chooseStableProgress(sourceText, cue, rawProgress, videoTime);
    const position = weightedTokenPosition(tokens, progress);

    tokens.forEach((range) => {
      const current = range.index === position.index;
      const local = current ? position.localProgress : 0;
      const pct = `${Math.round(local * 1000) / 10}%`;
      if (range.token.style.getPropertyValue('--ytort-word-progress') !== pct) {
        range.token.style.setProperty('--ytort-word-progress', pct);
      }
      range.token.classList.toggle('ytort-generic-current', current);
      if (current) range.token.setAttribute('aria-current', 'true');
      else range.token.removeAttribute('aria-current');
    });
  }

  function clearWordSweep(wrap) {
    wrap.querySelectorAll('.ytort-generic-token').forEach((token) => {
      token.classList.remove('ytort-generic-current');
      token.removeAttribute('aria-current');
      token.style.setProperty('--ytort-word-progress', '0%');
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-active { display:none !important; }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-base { color:inherit !important; filter:none !important; }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-generic-token {
      display:inline-grid !important;
      grid-template-areas:'word-sweep';
      place-items:center;
      position:relative;
      overflow:hidden;
      opacity:1 !important;
      filter:none !important;
      transform:translateY(0) scale(1);
      transition:transform 90ms ease, box-shadow 90ms ease;
      will-change:transform;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-word-sweep-base,
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-word-sweep-active {
      grid-area:word-sweep;
      display:inline-block;
      white-space:pre;
      pointer-events:none;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-word-sweep-base {
      opacity:.42;
      filter:saturate(.58) brightness(.78);
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-word-sweep-active {
      opacity:1;
      filter:saturate(1.12) brightness(1.20);
      clip-path:inset(0 calc(100% - var(--ytort-word-progress, 0%)) 0 0);
      will-change:clip-path;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-generic-token.ytort-generic-current {
      transform:translateY(-1px) scale(1.035);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.20),0 0 0 1px rgba(255,255,255,.16),0 3px 10px rgba(0,0,0,.26);
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
      return;
    }
    if (data.type !== 'YOUTUBE_TIMEDTEXT_RESPONSE') return;
    const payload = data.payload || {};
    if (payload.selectionKey && currentSelectionKey && payload.selectionKey !== currentSelectionKey) return;
    const parsed = parsePayload(payload);
    if (parsed.length) {
      cues = parsed;
      state = freshState();
    }
  });

  function tick() {
    const wrap = document.querySelector(`#${OVERLAY_ID} .${GENERIC_CLASS}`);
    const video = wrap ? findVideo() : null;
    if (wrap && video) {
      const sourceText = normalizeText(wrap.dataset.sourceText || wrap.textContent || '');
      const cue = findCue(sourceText, video.currentTime);
      if (cue) applyWordSweep(wrap, cue, video.currentTime);
      else {
        clearWordSweep(wrap);
        if (Number.isFinite(state.videoTime) && video.currentTime < state.videoTime - 0.2) state = freshState();
      }
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
