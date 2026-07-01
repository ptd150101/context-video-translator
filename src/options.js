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

const ids = Object.keys(DEFAULT_SETTINGS);
const statusEl = document.getElementById('status');

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'Empty response' });
    });
  });
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#fecaca' : '#a7f3d0';
}

function readForm() {
  const result = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') result[id] = el.checked;
    else if (el.type === 'number') result[id] = Number(el.value);
    else result[id] = el.value;
  }
  return result;
}

function writeForm(settings) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = settings[id] ?? DEFAULT_SETTINGS[id];
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value;
  }
}

async function load() {
  const res = await sendMessage({ type: 'GET_SETTINGS' });
  if (!res.ok) {
    setStatus(res.error || 'Failed to load settings', true);
    writeForm(DEFAULT_SETTINGS);
    return;
  }
  writeForm({ ...DEFAULT_SETTINGS, ...res.settings });
}

async function save() {
  const res = await sendMessage({ type: 'SAVE_SETTINGS', payload: readForm() });
  if (!res.ok) return setStatus(res.error || 'Failed to save settings', true);
  writeForm(res.settings);
  setStatus('Saved. Reload the video page if content script already loaded.');
}

async function testConnection() {
  setStatus('Testing connection...');
  const res = await sendMessage({ type: 'TEST_CONNECTION', payload: readForm() });
  if (!res.ok) return setStatus(res.error || 'Connection failed', true);
  setStatus(`Connection OK: ${res.text}`);
}

async function clearCache() {
  const ok = confirm('Clear all cached translations?');
  if (!ok) return;
  const res = await sendMessage({ type: 'CLEAR_CACHE' });
  if (!res.ok) return setStatus(res.error || 'Failed to clear cache', true);
  setStatus('Cache cleared.');
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', testConnection);
document.getElementById('clearCache').addEventListener('click', clearCache);

load();
