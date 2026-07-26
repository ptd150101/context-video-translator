(() => {
  if (window.__YTORT_TRANSLATED_CAPTION_EVENT_GUARD__) return;
  window.__YTORT_TRANSLATED_CAPTION_EVENT_GUARD__ = true;

  const SOURCE = 'yt-openai-realtime-translator-main';
  const GUARDED = '__ytortCaptionEventGuarded';

  function normalizeLang(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
  }

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }

  function hasKana(value) {
    return /[\u3040-\u30ff]/.test(String(value || ''));
  }

  function hasHangul(value) {
    return /[\uac00-\ud7af]/.test(String(value || ''));
  }

  function eventText(event) {
    return (Array.isArray(event?.segs) ? event.segs : [])
      .map((segment) => String(segment?.utf8 || ''))
      .join('');
  }

  function chooseJapaneseText(rawText) {
    const raw = String(rawText || '').replace(/\r/g, '');
    if (!hasKana(raw) || !hasHangul(raw)) return rawText;

    // YouTube can place the source and translated display lines in one JSON3
    // event. The native player treats them as alternative lines, while the
    // extension's generic parser collapses the newline and displays both.
    const lines = raw.split(/\n+/).map(normalizeText).filter(Boolean);
    const japaneseLines = lines.filter((line) => hasKana(line) && !hasHangul(line));
    if (japaneseLines.length) return japaneseLines.join(' ');

    const sentences = normalizeText(raw)
      .split(/(?<=[.!?。！？])\s*/u)
      .map(normalizeText)
      .filter(Boolean);
    const japaneseSentences = sentences.filter((part) => hasKana(part) && !hasHangul(part));
    if (japaneseSentences.length) return japaneseSentences.join(' ');

    // Fallback for responses where the newline was embedded inside a segment or
    // removed upstream. Anchor on the first kana and include any leading Kanji
    // belonging to that Japanese sentence, but stop at Hangul/source punctuation.
    const firstKana = raw.search(/[\u3040-\u30ff]/);
    if (firstKana >= 0) {
      let start = firstKana;
      while (start > 0) {
        const ch = raw[start - 1];
        if (/[\u3400-\u9fff々〆ヵヶ]/.test(ch)) {
          start -= 1;
          continue;
        }
        if (/\s/.test(ch)) {
          start -= 1;
          continue;
        }
        break;
      }
      const candidate = normalizeText(raw.slice(start));
      if (hasKana(candidate) && !hasHangul(candidate)) return candidate;
    }

    return rawText;
  }

  function eventTiming(event, index) {
    const start = Number(event?.tStartMs || 0);
    const duration = Math.max(1, Number(event?.dDurationMs || 0) || 2500);
    return {
      index,
      start,
      end: start + duration,
      duration,
      text: normalizeText(eventText(event))
    };
  }

  function overlapRatio(left, right) {
    const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
    return overlap / Math.max(1, Math.min(left.duration, right.duration));
  }

  function sanitizeJapaneseEvents(events) {
    const sanitized = events.map((event) => {
      const raw = eventText(event);
      const selected = chooseJapaneseText(raw);
      if (selected === raw || normalizeText(selected) === normalizeText(raw)) return event;
      const firstOffset = Number(event?.segs?.[0]?.tOffsetMs || 0);
      return {
        ...event,
        segs: [{ utf8: selected, tOffsetMs: firstOffset }]
      };
    });

    // If source-only and Japanese replacement events are separate but overlap,
    // discard only the source event. This is target-aware and does not alter
    // ordinary Japanese events or non-overlapping Korean captions.
    const timed = sanitized.map(eventTiming).filter((item) => item.text);
    const remove = new Set();
    for (const left of timed) {
      if (!hasHangul(left.text) || hasKana(left.text)) continue;
      for (const right of timed) {
        if (right.index === left.index || right.index < left.index) continue;
        if (!hasKana(right.text)) continue;
        if (Math.abs(right.start - left.start) > 900 && overlapRatio(left, right) < 0.65) continue;
        if (overlapRatio(left, right) >= 0.55 || Math.abs(right.start - left.start) <= 350) {
          remove.add(left.index);
          break;
        }
      }
    }
    return sanitized.filter((_, index) => !remove.has(index));
  }

  function sanitizePayload(payload) {
    const target = normalizeLang(payload?.requestedTlang || payload?.rawLang || '');
    if (!(target === 'ja' || target.startsWith('ja-'))) return payload;
    const body = String(payload?.body || '').trim();
    if (!body.startsWith('{')) return payload;

    try {
      const data = JSON.parse(body);
      if (!Array.isArray(data?.events) || !data.events.length) return payload;
      const events = sanitizeJapaneseEvents(data.events);
      if (events.length === data.events.length && events.every((event, index) => event === data.events[index])) return payload;
      data.events = events;
      return { ...payload, body: JSON.stringify(data), [GUARDED]: true };
    } catch {
      return payload;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== SOURCE || data?.type !== 'YOUTUBE_TIMEDTEXT_RESPONSE') return;
    if (data.payload?.[GUARDED]) return;

    const nextPayload = sanitizePayload(data.payload || {});
    if (nextPayload === data.payload) return;

    // This script is loaded before youtube-content.js in the same isolated world.
    // Prevent the unsanitized message from reaching later listeners, then repost
    // the corrected payload on the next microtask.
    event.stopImmediatePropagation();
    queueMicrotask(() => {
      window.postMessage({ ...data, payload: nextPayload }, '*');
    });
  }, true);
})();
