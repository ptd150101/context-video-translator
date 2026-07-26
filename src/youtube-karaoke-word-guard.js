(() => {
  if (window.__YTORT_KARAOKE_WORD_GUARD__) return;
  window.__YTORT_KARAOKE_WORD_GUARD__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const GENERIC_CLASS = 'ytort-generic-karaoke';

  let currentSelectionKey = '';
  let timingItems = [];
  let motion = freshMotion();

  function freshMotion() {
    return {
      sourceText: '',
      tokenIndex: -1,
      videoTime: NaN,
      itemKey: '',
      itemStart: NaN,
      lastHadItemAt: NaN
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

  function parseJson3(body) {
    const data = JSON.parse(body);
    const events = Array.isArray(data?.events) ? data.events : [];
    const output = [];

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex] || {};
      const segs = (Array.isArray(event.segs) ? event.segs : [])
        .filter((segment) => normalizeText(segment?.utf8));
      if (!segs.length) continue;

      const eventStartMs = Number(event.tStartMs || 0);
      const eventDurationMs = Math.max(250, Number(event.dDurationMs || 0) || 2500);
      const eventEndMs = eventStartMs + eventDurationMs;
      const eventText = normalizeText(segs.map((segment) => segment.utf8 || '').join(''));

      for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex += 1) {
        const segment = segs[segmentIndex];
        const startMs = eventStartMs + Number(segment.tOffsetMs || 0);
        const nextSegment = segs[segmentIndex + 1];
        const endMs = nextSegment
          ? eventStartMs + Number(nextSegment.tOffsetMs || 0)
          : eventEndMs;
        const text = normalizeText(segment.utf8 || '');
        if (!text) continue;
        output.push({
          key: `json3:${eventIndex}:${segmentIndex}:${startMs}:${text}`,
          start: startMs / 1000,
          end: Math.max(endMs / 1000, startMs / 1000 + 0.08),
          eventStart: eventStartMs / 1000,
          eventEnd: Math.max(eventEndMs / 1000, eventStartMs / 1000 + 0.25),
          text,
          eventText,
          segmentIndex,
          segmentCount: segs.length
        });
      }
    }

    return output.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function parseXml(body) {
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    return Array.from(doc.querySelectorAll('text'))
      .map((node, index) => {
        const start = Number(node.getAttribute('start') || 0);
        const duration = Math.max(0.25, Number(node.getAttribute('dur') || 2.5));
        const text = normalizeText(node.textContent || '');
        if (!text) return null;
        return {
          key: `xml:${index}:${start}:${text}`,
          start,
          end: start + duration,
          eventStart: start,
          eventEnd: start + duration,
          text,
          eventText: text,
          segmentIndex: 0,
          segmentCount: 1
        };
      })
      .filter(Boolean);
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

  function findActiveItem(time) {
    const t = Number(time) || 0;
    let selected = null;
    for (const item of timingItems) {
      if (item.start > t + 0.12) break;
      if (t >= item.start - 0.08 && t <= item.end + 0.12) selected = item;
    }
    return selected;
  }

  function tokenRanges(wrap) {
    const sourceText = normalizeText(wrap.dataset.sourceText || wrap.textContent || '');
    const tokens = Array.from(wrap.querySelectorAll('.ytort-karaoke-base .ytort-generic-token'));
    let cursor = 0;
    return {
      sourceText,
      tokens: tokens.map((token, index) => {
        const text = normalizeText(token.textContent || '');
        let start = sourceText.indexOf(text, cursor);
        if (start < 0) start = cursor;
        const end = Math.min(sourceText.length, start + text.length);
        cursor = Math.max(cursor, end);
        return { token, index, text, start, end, comparable: comparable(text) };
      })
    };
  }

  function matchingTokenIndex(item, ranges, time) {
    const needle = comparable(item?.text || '');
    if (needle) {
      const exact = ranges.find((range) => range.comparable === needle);
      if (exact) return exact.index;
      const containing = ranges.find((range) => (
        range.comparable && (range.comparable.includes(needle) || needle.includes(range.comparable))
      ));
      if (containing) return containing.index;
    }

    const eventNeedle = comparable(item?.eventText || '');
    if (eventNeedle && ranges.length > 1 && item?.segmentCount > 1) {
      const ratio = Math.max(0, Math.min(0.999, item.segmentIndex / item.segmentCount));
      return Math.min(ranges.length - 1, Math.floor(ratio * ranges.length));
    }

    const duration = Math.max(0.25, Number(item?.eventEnd || 0) - Number(item?.eventStart || 0));
    const ratio = Math.max(0, Math.min(0.999, (Number(time) - Number(item?.eventStart || 0)) / duration));
    return Math.min(ranges.length - 1, Math.floor(ratio * ranges.length));
  }

  function chooseStableIndex(sourceText, item, candidate, tokenCount, videoTime) {
    const previousText = motion.sourceText;
    const textCompatible = previousText === sourceText
      || sourceText.startsWith(previousText)
      || previousText.startsWith(sourceText);
    const movingForward = !Number.isFinite(motion.videoTime) || videoTime >= motion.videoTime - 0.12;
    const recentlyActive = !Number.isFinite(motion.lastHadItemAt) || videoTime - motion.lastHadItemAt <= 1.2;
    const samePhrase = textCompatible && movingForward && recentlyActive;

    let next = candidate;
    if (samePhrase && motion.tokenIndex >= 0) {
      if (item.key !== motion.itemKey && candidate <= motion.tokenIndex && item.start > motion.itemStart + 0.03) {
        next = Math.min(tokenCount - 1, motion.tokenIndex + 1);
      } else {
        next = Math.max(motion.tokenIndex, candidate);
      }
    }

    motion.sourceText = sourceText;
    motion.tokenIndex = next;
    motion.videoTime = videoTime;
    motion.itemKey = item.key;
    motion.itemStart = item.start;
    motion.lastHadItemAt = videoTime;
    return next;
  }

  function applyCurrentToken(wrap, item, videoTime) {
    const { sourceText, tokens } = tokenRanges(wrap);
    if (!tokens.length || !item) return;
    const candidate = matchingTokenIndex(item, tokens, videoTime);
    const index = chooseStableIndex(sourceText, item, candidate, tokens.length, videoTime);

    tokens.forEach((range) => {
      const current = range.index === index;
      range.token.classList.toggle('ytort-generic-current', current);
      if (current) range.token.setAttribute('aria-current', 'true');
      else range.token.removeAttribute('aria-current');
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-active { display:none !important; }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-karaoke-base { color:inherit !important; filter:none !important; }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-generic-token {
      opacity:.44 !important;
      filter:saturate(.58) brightness(.78) !important;
      transform:translateY(0) scale(1);
      transition:opacity 90ms linear, filter 90ms linear, transform 90ms ease, box-shadow 90ms ease;
      will-change:opacity,filter,transform;
    }
    #${OVERLAY_ID} .${GENERIC_CLASS} .ytort-generic-token.ytort-generic-current {
      opacity:1 !important;
      filter:saturate(1.12) brightness(1.18) !important;
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
      timingItems = [];
      motion = freshMotion();
      return;
    }
    if (data.type !== 'YOUTUBE_TIMEDTEXT_RESPONSE') return;
    const payload = data.payload || {};
    if (payload.selectionKey && currentSelectionKey && payload.selectionKey !== currentSelectionKey) return;
    const parsed = parsePayload(payload);
    if (parsed.length) {
      timingItems = parsed;
      motion = freshMotion();
    }
  });

  function tick() {
    const wrap = document.querySelector(`#${OVERLAY_ID} .${GENERIC_CLASS}`);
    const video = wrap ? findVideo() : null;
    if (wrap && video) {
      const item = findActiveItem(video.currentTime);
      if (item) applyCurrentToken(wrap, item, video.currentTime);
      else if (Number.isFinite(motion.videoTime) && video.currentTime < motion.videoTime - 0.2) motion = freshMotion();
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
