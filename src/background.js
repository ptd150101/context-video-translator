const OLD_DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const OLD_DEFAULT_MODEL = 'qwen2.5-3b-instruct';

const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: 'Vietnamese',
  sourceLang: 'auto',
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  model: 'cx/gpt-5.4-mini',
  temperature: 0,
  batchSize: 12,
  aheadSeconds: 60,
  maxRetries: 2,
  showOriginal: true,
  hideNativeCaptions: true,
    enableUdemy: true,
    udemySourceLang: 'auto',
    hideUdemyNativeCaptions: false,
  coverHardSub: false,
  hardSubMaskOpacity: 0.72,
  hardSubMaskBlur: 2,
  hardSubMaskRadius: 8,
  overlayFontSize: 22,
  studyMode: false,
  studyHighlight: true,
  studyChunkMode: false,
  studyFurigana: false,
  studyFuriganaEngine: 'auto',
  studyFuriganaStyle: 'smart',
  studyFuriganaDisplay: 'kanji',
  studyTooltips: true,
  studySpeakingHighlight: true,
  subtitleDynamicHeight: true,
  subtitleCompactLayout: true,
  subtitleMaxHeightPct: 34,
  subtitleAnchor: 'auto',
  subtitleDensity: 'compact',
  studyKaraokeUiVersion: 1,
  cacheEnabled: true,
  cacheTtlDays: 30,
  cacheMaxEntries: 10000,
  debug: false
};

const DB_NAME = 'yt-openai-realtime-translator';
const DB_VERSION = 1;
const STORE_NAME = 'translations';
let dbPromise = null;
let evicting = false;

function storageGet(keys = null) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

async function getSettings() {
  const stored = await storageGet('settings');
  const storedSettings = stored.settings || {};
  const merged = { ...DEFAULT_SETTINGS, ...storedSettings };

  // Provider migration: if the user is still on the old bundled local default,
  // move them to the new requested default without touching custom providers.
  if (!storedSettings.baseUrl || storedSettings.baseUrl === OLD_DEFAULT_BASE_URL) {
    merged.baseUrl = DEFAULT_SETTINGS.baseUrl;
  }
  if (!storedSettings.model || storedSettings.model === OLD_DEFAULT_MODEL) {
    merged.model = DEFAULT_SETTINGS.model;
  }

  // One-time UI migration: the previous build defaulted to many colored chunks
  // and per-chunk speaking glow. The karaoke build should open clean even for
  // users who already had old settings saved.
  if (storedSettings.studyKaraokeUiVersion !== DEFAULT_SETTINGS.studyKaraokeUiVersion) {
    merged.studyChunkMode = false;
    merged.studySpeakingHighlight = true;
    merged.studyKaraokeUiVersion = DEFAULT_SETTINGS.studyKaraokeUiVersion;
  }
  return merged;
}

async function saveSettings(settings) {
  const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
  await storageSet({ settings: normalized });
  return normalized;
}

function normalizeSettings(settings) {
  const s = { ...settings };
  s.baseUrl = String(s.baseUrl || '').trim().replace(/\/+$/, '');
  s.apiKey = String(s.apiKey || '').trim();
  s.model = String(s.model || '').trim();
  s.targetLang = String(s.targetLang || 'Vietnamese').trim();
  s.sourceLang = String(s.sourceLang || 'auto').trim();
  s.udemySourceLang = String(s.udemySourceLang || 'auto').trim();
  s.temperature = Number.isFinite(Number(s.temperature)) ? Number(s.temperature) : 0;
  s.batchSize = clampInt(s.batchSize, 1, 50, DEFAULT_SETTINGS.batchSize);
  s.aheadSeconds = clampInt(s.aheadSeconds, 5, 600, DEFAULT_SETTINGS.aheadSeconds);
  s.maxRetries = clampInt(s.maxRetries, 0, 5, DEFAULT_SETTINGS.maxRetries);
  s.overlayFontSize = clampInt(s.overlayFontSize, 12, 48, DEFAULT_SETTINGS.overlayFontSize);
  s.hardSubMaskOpacity = clampFloat(s.hardSubMaskOpacity, 0, 1, DEFAULT_SETTINGS.hardSubMaskOpacity);
  s.hardSubMaskBlur = clampFloat(s.hardSubMaskBlur, 0, 8, DEFAULT_SETTINGS.hardSubMaskBlur);
  s.hardSubMaskRadius = clampInt(s.hardSubMaskRadius, 0, 32, DEFAULT_SETTINGS.hardSubMaskRadius);
  s.subtitleMaxHeightPct = clampInt(s.subtitleMaxHeightPct, 18, 70, DEFAULT_SETTINGS.subtitleMaxHeightPct);
  s.subtitleAnchor = ['auto', 'top', 'bottom'].includes(s.subtitleAnchor) ? s.subtitleAnchor : DEFAULT_SETTINGS.subtitleAnchor;
  s.subtitleDensity = ['comfortable', 'compact', 'ultra'].includes(s.subtitleDensity) ? s.subtitleDensity : DEFAULT_SETTINGS.subtitleDensity;
  s.cacheTtlDays = clampInt(s.cacheTtlDays, 1, 365, DEFAULT_SETTINGS.cacheTtlDays);
  s.cacheMaxEntries = clampInt(s.cacheMaxEntries, 100, 100000, DEFAULT_SETTINGS.cacheMaxEntries);
  s.enabled = Boolean(s.enabled);
  s.showOriginal = Boolean(s.showOriginal);
  s.hideNativeCaptions = Boolean(s.hideNativeCaptions);
  s.enableUdemy = Boolean(s.enableUdemy);
  s.hideUdemyNativeCaptions = Boolean(s.hideUdemyNativeCaptions);
  s.coverHardSub = Boolean(s.coverHardSub);
  s.subtitleDynamicHeight = Boolean(s.subtitleDynamicHeight);
  s.subtitleCompactLayout = Boolean(s.subtitleCompactLayout);
  s.cacheEnabled = Boolean(s.cacheEnabled);
  s.studyMode = Boolean(s.studyMode);
  s.studyHighlight = Boolean(s.studyHighlight);
  s.studyChunkMode = Boolean(s.studyChunkMode);
  s.studyFurigana = Boolean(s.studyFurigana);
  s.studyFuriganaEngine = ['auto', 'kuromoji', 'lightweight'].includes(s.studyFuriganaEngine) ? s.studyFuriganaEngine : DEFAULT_SETTINGS.studyFuriganaEngine;
  s.studyFuriganaStyle = ['smart', 'basic'].includes(s.studyFuriganaStyle) ? s.studyFuriganaStyle : DEFAULT_SETTINGS.studyFuriganaStyle;
  s.studyFuriganaDisplay = ['kanji', 'current', 'hover'].includes(s.studyFuriganaDisplay) ? s.studyFuriganaDisplay : DEFAULT_SETTINGS.studyFuriganaDisplay;
  s.studyTooltips = Boolean(s.studyTooltips);
  s.studySpeakingHighlight = Boolean(s.studySpeakingHighlight);
  s.studyKaraokeUiVersion = DEFAULT_SETTINGS.studyKaraokeUiVersion;
  s.debug = Boolean(s.debug);
  return s;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function normalizeTextForCache(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function hashString(str) {
  // cyrb53, deterministic and short enough for IndexedDB keys.
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
}

function cacheKey(settings, text, sourceLang) {
  const material = [
    'openai-compatible-v2',
    settings.baseUrl,
    settings.model,
    sourceLang || settings.sourceLang || 'auto',
    settings.targetLang,
    normalizeTextForCache(text)
  ].join('\n');
  return hashString(material);
}

async function getCached(settings, text, sourceLang) {
  if (!settings.cacheEnabled) return undefined;
  const key = cacheKey(settings, text, sourceLang);
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const entry = await idbRequest(store.get(key));
  await txDone(tx).catch(() => {});
  if (!entry) return undefined;
  const maxAgeMs = settings.cacheTtlDays * 24 * 60 * 60 * 1000;
  if (Date.now() - entry.ts > maxAgeMs) return undefined;
  return entry.translated;
}

async function setCached(settings, text, translated, sourceLang) {
  if (!settings.cacheEnabled || !text || !translated) return;
  const key = cacheKey(settings, text, sourceLang);
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    key,
    text: normalizeTextForCache(text),
    translated,
    ts: Date.now()
  });
  await txDone(tx);
}

async function clearCache() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await txDone(tx);
}

async function evictOldEntries(settings) {
  if (evicting || !settings.cacheEnabled) return;
  evicting = true;
  try {
    const db = await openDB();
    const cutoff = Date.now() - settings.cacheTtlDays * 24 * 60 * 60 * 1000;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('ts');

    await new Promise((resolve, reject) => {
      const req = index.openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    const count = await idbRequest(store.count());
    if (count > settings.cacheMaxEntries) {
      let excess = count - settings.cacheMaxEntries;
      await new Promise((resolve, reject) => {
        const req = index.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || excess <= 0) return resolve();
          cursor.delete();
          excess -= 1;
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }
    await txDone(tx);
  } catch (err) {
    console.warn('[YT-Translator] Cache eviction failed:', err);
  } finally {
    evicting = false;
  }
}

function buildNumberedInput(items) {
  return items.map((item, i) => `[${i + 1}] ${item.text}`).join('\n');
}

function buildPrompts(items, settings, request) {
  const source = request.sourceLang || settings.sourceLang || 'auto';
  const target = settings.targetLang || 'Vietnamese';
  const system = [
    'You are a subtitle translator.',
    `Translate subtitles from ${source} into ${target}.`,
    'Return ONLY translated numbered lines in the exact format: [N] translated text.',
    `The input has ${items.length} lines. The output MUST have exactly ${items.length} lines with the same numbers.`,
    'Keep subtitles concise and natural.',
    'Do not copy the source line unchanged unless it is already in the target language or is a proper noun/code/URL.',
    'If the source is Japanese/English/etc. and the target is Vietnamese, the output MUST be Vietnamese.',
    'Preserve proper nouns, code, URLs, file names, commands, and product names when appropriate.',
    'Do not add explanations, notes, markdown, JSON, or extra text.'
  ].join('\n');

  const contextParts = [];
  if (Array.isArray(request.previousContext) && request.previousContext.length) {
    contextParts.push('Previous context, do not translate these lines unless they appear below:');
    contextParts.push(request.previousContext.map((t) => `- ${t}`).join('\n'));
  }
  if (Array.isArray(request.futureContext) && request.futureContext.length) {
    contextParts.push('Future context, do not translate these lines unless they appear below:');
    contextParts.push(request.futureContext.map((t) => `- ${t}`).join('\n'));
  }

  const user = [
    ...contextParts,
    `Translate these ${items.length} numbered subtitle lines into ${target}:`,
    buildNumberedInput(items)
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

function parseNumberedOutput(output, expectedCount) {
  const results = new Array(expectedCount).fill('');
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const patterns = [
    /^\[(\d+)\]\s*(.*)$/,
    /^(\d+)\.\s+(.*)$/,
    /^(\d+)\)\s+(.*)$/,
    /^（(\d+)）\s*(.*)$/
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const index = Number(match[1]) - 1;
        if (index >= 0 && index < expectedCount) {
          results[index] = String(match[2] || '').trim();
        }
        break;
      }
    }
  }

  const missing = results.map((v, i) => (!v ? i + 1 : null)).filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing translated lines: ${missing.join(', ')}`);
  }
  return results;
}

function parseBestEffort(output, expectedCount, fallbackTexts) {
  try {
    return parseNumberedOutput(output, expectedCount);
  } catch {}

  const cleaned = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^\[?\d+\]?\s*[.)：:-]?\s*/, '').trim())
    .filter(Boolean);

  if (cleaned.length >= expectedCount) return cleaned.slice(0, expectedCount);
  return fallbackTexts.map((text, i) => cleaned[i] || text);
}

async function callOpenAICompatible(items, settings, request) {
  if (!settings.baseUrl) throw new Error('Base URL is empty');
  if (!settings.model) throw new Error('Model is empty');

  const { system, user } = buildPrompts(items, settings, request);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const body = {
    model: settings.model,
    temperature: settings.temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  let lastError = null;
  let lastOutput = '';
  let gotModelResponse = false;
  const maxAttempts = Math.max(1, settings.maxRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${raw}`.trim());
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid JSON response: ${raw.slice(0, 500)}`);
      }
      lastOutput = String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '').trim();
      gotModelResponse = true;
      if (!lastOutput) throw new Error('Model returned an empty translation response');
      return parseNumberedOutput(lastOutput, items.length);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await sleep(350 * attempt);
    }
  }

  // Only use best-effort parsing when the model actually returned text but the format was off.
  // Never silently fall back to the original subtitles on network/API failures, because that
  // makes the overlay look "translated" while showing the same source text.
  if (gotModelResponse && lastOutput) {
    const bestEffort = parseBestEffort(lastOutput, items.length, items.map((item) => item.text));
    const unchanged = bestEffort.filter((text, i) => normalizeTextForCache(text) === normalizeTextForCache(items[i].text)).length;
    if (unchanged === bestEffort.length) {
      throw new Error(
        `Model output was unchanged or could not be parsed. Check target language/model. Raw output: ${lastOutput.slice(0, 300)}`
      );
    }
    console.warn('[YT-Translator] Used best-effort parse for model output:', lastOutput);
    return bestEffort;
  }

  throw lastError || new Error('Translation request failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateBatch(request) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: true, disabled: true, translations: {} };
  }

  const items = Array.isArray(request.items) ? request.items.filter((item) => item && item.id && item.text) : [];
  if (!items.length) return { ok: true, translations: {} };

  const translations = {};
  const uncached = [];
  const uncachedPositions = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const cached = await getCached(settings, item.text, request.sourceLang);
    if (cached !== undefined) {
      translations[item.id] = cached;
    } else {
      uncached.push(item);
      uncachedPositions.push(i);
    }
  }

  if (uncached.length) {
    const translated = await callOpenAICompatible(uncached, settings, request);
    for (let i = 0; i < uncached.length; i += 1) {
      const item = uncached[i];
      const text = translated[i] || item.text;
      translations[item.id] = text;
      await setCached(settings, item.text, text, request.sourceLang);
    }
    evictOldEntries(settings);
  }

  return { ok: true, translations };
}

async function testConnection(settingsPatch = {}) {
  const settings = normalizeSettings({ ...(await getSettings()), ...settingsPatch });
  const result = await callOpenAICompatible(
    [{ id: '1', text: 'Hello, this is a subtitle test.' }],
    settings,
    { sourceLang: 'English', previousContext: [], futureContext: [] }
  );
  return { ok: true, text: result[0] };
}


async function fetchTextForContent(payload = {}) {
  const url = String(payload.url || '').trim();
  if (!url) return { ok: false, error: 'Missing URL' };
  const res = await fetch(url, { credentials: 'include' });
  const body = await res.text();
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  return { ok: true, url: res.url || url, body, contentType: res.headers.get('content-type') || '' };
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await storageGet('settings');
  if (!stored.settings) await storageSet({ settings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'GET_SETTINGS') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (message?.type === 'SAVE_SETTINGS') {
        sendResponse({ ok: true, settings: await saveSettings(message.payload || {}) });
      } else if (message?.type === 'TRANSLATE_BATCH') {
        sendResponse(await translateBatch(message.payload || {}));
      } else if (message?.type === 'TEST_CONNECTION') {
        sendResponse(await testConnection(message.payload || {}));
      } else if (message?.type === 'CLEAR_CACHE') {
        await clearCache();
        sendResponse({ ok: true });
      } else if (message?.type === 'FETCH_TEXT') {
        sendResponse(await fetchTextForContent(message.payload || {}));
      } else {
        sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      }
    } catch (err) {
      console.error('[YT-Translator] Background error:', err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
