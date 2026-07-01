(() => {
  if (window.__YT_OPENAI_SUBTITLE_TRANSLATOR_CONTENT__) return;
  window.__YT_OPENAI_SUBTITLE_TRANSLATOR_CONTENT__ = true;

  const MAIN_SOURCE = 'yt-openai-realtime-translator-main';
  const UDEMY_MAIN_SOURCE = 'yt-openai-realtime-translator-udemy-main';
  const CONTENT_SOURCE = 'yt-openai-realtime-translator-content';
  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const MASK_ID = 'yt-openai-realtime-translator-hard-sub-mask';
  const EDIT_TOGGLE_ID = 'yt-openai-realtime-translator-edit-toggle';
  const EDIT_TOOLBAR_ID = 'yt-openai-realtime-translator-edit-toolbar';
  const STYLE_ID = 'yt-openai-realtime-translator-style';
  const NATIVE_HIDE_STYLE_ID = 'yt-openai-realtime-translator-native-hide';

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLang: 'Vietnamese',
    sourceLang: 'auto',
    batchSize: 12,
    aheadSeconds: 60,
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
    debug: false
  };

  let settings = { ...DEFAULT_SETTINGS };
  let video = null;
  let currentVideoId = '';
  let currentTrackKey = '';
  let currentSourceLang = 'auto';
  let cues = [];
  let cueMap = new Map();
  let pendingIds = new Set();
  let activeCueId = null;
  let activeTranslated = null;
  let activeStudyProgressKey = null;
  let cueDisplayStarts = [];
  let timingEventsVideo = null;
  let timingRafId = 0;
  let seekingInProgress = false;
  let seekTransitionTimer = null;
  let translateInFlight = false;
  let lastScheduleAt = 0;
  let lastRenderTick = 0;
  let lastUrgentScheduleAt = 0;
  let lastVisibleCue = null;
  let lastVisibleCueWallTime = 0;
  let lastStablePlaybackTime = 0;
  let lastStablePlaybackWallTime = 0;
  let pendingUrgentTranslation = false;
  const udemyRenderState = {
    lockedVideo: null,
    lockedLectureKey: '',
    lockedVideoSignature: '',
    lockedBadSince: 0,
    lastRenderableCue: null,
    lastRenderableAt: 0,
    lastGoodVideoTime: 0,
    lastGoodVideoRect: null,
    lastHideReason: '',
    lastHideLogAt: 0,
    lastStateLog: '',
    lastStateLogAt: 0
  };
  let lastTimedTextHash = '';
  let fetchedOriginalUrls = new Set();
  let udemyCaptionCandidates = new Map();
  let udemyCaptionLoadInFlight = false;
  let udemyLectureApiInFlight = false;
  let lastUdemyCaptionDiscoveryAt = 0;
  let lastUdemyLectureApiAttemptAt = 0;
  let lastUdemyLectureApiKey = '';
  let lastUdemyTextTrackSignature = '';
  let statusMessage = '';
  let udemyPageFetchSeq = 0;
  const udemyPageFetchPending = new Map();
  const studyAnalysisCache = new Map();
  let kuromojiTokenizer = null;
  let kuromojiTokenizerPromise = null;
  let kuromojiFailed = false;
  let kuromojiStatus = 'idle';
  const DEFAULT_HARD_SUB_MASK_REGION = { leftPct: 8, topPct: 70, widthPct: 84, heightPct: 16 };
  const DEFAULT_SUBTITLE_BOX_REGION = { leftPct: 10, topPct: 78, widthPct: 80, heightPct: 16 };
  let layout = {
    hardSubMask: { ...DEFAULT_HARD_SUB_MASK_REGION },
    subtitleBox: { ...DEFAULT_SUBTITLE_BOX_REGION }
  };
  let layoutBeforeEdit = null;
  let editMode = false;
  let selectedLayoutTarget = 'mask';
  let dragState = null;

  function log(...args) {
    if (settings.debug) console.log('[Video-Translator]', ...args);
  }

  function describeError(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch { return String(err); }
  }

  function logUdemyRenderState(reason, details = {}, throttleMs = 900) {
    if (!settings.debug || !isUdemyPlatform()) return;
    const now = performance.now();
    const key = `${reason}:${JSON.stringify(details).slice(0, 220)}`;
    if (udemyRenderState.lastStateLog === key && now - udemyRenderState.lastStateLogAt < throttleMs) return;
    udemyRenderState.lastStateLog = key;
    udemyRenderState.lastStateLogAt = now;
    console.debug('[Video-Translator] [UdemyRender]', reason, details);
  }

  function safeVideoRect(v) {
    try {
      const r = v?.getBoundingClientRect?.();
      if (!r) return null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  function getVideoSignature(v) {
    if (!v) return '';
    const src = v.currentSrc || v.src || '';
    const duration = Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0;
    return `${src}|${duration}`;
  }

  function resetUdemyRenderState({ keepVideo = false } = {}) {
    if (!keepVideo) {
      udemyRenderState.lockedVideo = null;
      udemyRenderState.lockedLectureKey = '';
      udemyRenderState.lockedVideoSignature = '';
      udemyRenderState.lockedBadSince = 0;
    }
    udemyRenderState.lastRenderableCue = null;
    udemyRenderState.lastRenderableAt = 0;
    udemyRenderState.lastGoodVideoTime = 0;
    udemyRenderState.lastGoodVideoRect = null;
    udemyRenderState.lastHideReason = '';
    udemyRenderState.lastHideLogAt = 0;
  }

  function handleUdemyPageFetchResult(payload = {}) {
    const requestId = payload.requestId;
    const pending = udemyPageFetchPending.get(requestId);
    if (!pending) return;
    udemyPageFetchPending.delete(requestId);
    clearTimeout(pending.timer);
    if (payload.ok) {
      pending.resolve(payload);
    } else {
      pending.reject(new Error(payload.error || `HTTP ${payload.status || 0}`));
    }
  }

  function getFetchCredentialsForUrl(url, fallback = 'include') {
    try {
      const u = new URL(url, location.href);
      // Signed Udemy CDN VTT URLs do not allow credentialed CORS. The signature in
      // the URL is the authorization, so credentials must be omitted.
      if (/\.udemycdn\.com$/i.test(u.hostname) || /(?:^|\.)udemycdn\.com$/i.test(u.hostname)) return 'omit';
      if (u.origin !== location.origin && /\.vtt(?:$|[?#])/i.test(u.pathname)) return 'omit';
    } catch {}
    return fallback;
  }

  function fetchTextInUdemyPage(url, options = {}) {
    if (!isUdemyPlatform()) return Promise.reject(new Error('Page fetch is only available on Udemy'));
    const requestId = `udemy-page-fetch-${Date.now()}-${++udemyPageFetchSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        udemyPageFetchPending.delete(requestId);
        reject(new Error('Udemy page fetch timed out'));
      }, options.timeoutMs || 9000);
      udemyPageFetchPending.set(requestId, { resolve, reject, timer });
      window.postMessage({
        source: CONTENT_SOURCE,
        type: 'UDEMY_PAGE_FETCH_TEXT',
        payload: {
          requestId,
          url,
          headers: options.headers || {},
          credentials: options.credentials || getFetchCredentialsForUrl(url, 'include')
        }
      }, '*');
    });
  }

  function getPlatformId() {
    return /(^|\.)udemy\.com$/i.test(location.hostname) ? 'udemy' : 'youtube';
  }

  function isUdemyPlatform() {
    return getPlatformId() === 'udemy';
  }

  function platformLabel() {
    return isUdemyPlatform() ? 'Udemy' : 'YouTube';
  }

  function getDefaultStatusMessage() {
    if (isUdemyPlatform()) return 'Waiting for Udemy captions. Open a lecture and enable captions if needed.';
    return 'Waiting for YouTube captions. Turn captions on if nothing appears.';
  }

  function isPlatformEnabled() {
    return Boolean(settings.enabled && (!isUdemyPlatform() || settings.enableUdemy));
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: 'Empty response' });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  async function loadSettings() {
    const res = await sendMessage({ type: 'GET_SETTINGS' });
    if (res.ok) {
      settings = { ...DEFAULT_SETTINGS, ...res.settings };
      applyNativeCaptionVisibility();
      updateOverlayStyles();
      updateLayoutStyles();
      if (canUseKuromoji()) ensureKuromojiTokenizer();
    }
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local' || !changes.settings) return;
    const prevSettings = settings;
    settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    if (['studyMode', 'studyHighlight', 'studyChunkMode', 'studyFurigana', 'studyFuriganaEngine', 'studyFuriganaStyle', 'studyFuriganaDisplay', 'studySpeakingHighlight'].some((key) => prevSettings[key] !== settings[key])) {
      studyAnalysisCache.clear();
      if (canUseKuromoji()) ensureKuromojiTokenizer();
    }
    applyNativeCaptionVisibility();
    updateOverlayStyles();
    updateLayoutStyles();
    activeCueId = null;
    activeTranslated = null;
    scheduleAhead(true);
    renderNow(true);
  });

  function extractCurrentVideoId() {
    if (isUdemyPlatform()) return extractCurrentUdemyLectureKey();
    try {
      const url = new URL(location.href);
      return url.searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function extractCurrentUdemyLectureKey() {
    try {
      const url = new URL(location.href);
      const courseMatch = url.pathname.match(/\/course\/([^/]+)/i);
      const lectureMatch = url.pathname.match(/\/lecture\/(\d+)/i)
        || url.search.match(/[?&]lectureId=(\d+)/i)
        || document.body?.innerHTML?.match(/\blectureId[\"':\s]+(\d{4,})/i);
      const course = courseMatch ? courseMatch[1] : 'course';
      const lecture = lectureMatch ? lectureMatch[1] : hashString(url.pathname + url.search).slice(0, 10);
      return `${course}:${lecture}`;
    } catch {
      return `udemy:${hashString(location.href).slice(0, 10)}`;
    }
  }


  function extractUdemyLectureId() {
    try {
      const url = new URL(location.href);
      const fromPath = url.pathname.match(/\/lecture\/(\d+)/i);
      if (fromPath) return fromPath[1];
      const fromSearch = url.search.match(/[?&](?:lectureId|lecture_id|curriculumId|curriculum_id)=(\d+)/i);
      if (fromSearch) return fromSearch[1];
      const html = document.documentElement?.innerHTML || document.body?.innerHTML || '';
      const fromHtml = html.match(/\b(?:lectureId|lecture_id|curriculumId|curriculum_id)["'\s:=]+(\d{4,})/i)
        || html.match(/"curriculum"\s*:\s*\{[^}]*"curriculumId"\s*:\s*(\d{4,})/i);
      return fromHtml ? fromHtml[1] : '';
    } catch {
      return '';
    }
  }

  function getCookieValue(name) {
    try {
      const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = (document.cookie || '').match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  function scoreUdemyCourseCandidate(item, lectureId = '') {
    const source = String(item?.source || '');
    let score = 1;
    if (/^url/.test(source)) score += 120;
    if (/performance:exact/.test(source)) score += 115;
    if (/api-response/.test(source)) score += 110;
    if (/module-args/.test(source)) score += 108;
    if (/html:subscribed-course/.test(source)) score += 100;
    if (/html:courseTakingHeader/.test(source)) score += 98;
    if (/script:courseTakingHeader/.test(source)) score += 96;
    if (/script:courseId/.test(source)) score += 86;
    if (/html:courseId/.test(source)) score += 78;
    if (/dom:/.test(source)) score += 68;
    if (/storage:sidebar:transcript|storage:sidebar:content/.test(source)) score += 44;
    if (/cookie:sidebar:transcript|cookie:sidebar:content/.test(source)) score += 40;
    // Udemy keeps old sidebar_content_<courseId>=none/dashboard_tab_<courseId>
    // cookies for courses the user visited before. Treat those as very weak
    // hints; otherwise we may call the lecture API with a stale course id and
    // get a 404, e.g. courseId=797156 for lectureId=43423610.
    if (/sidebar:(?:none|closed|unknown|undefined|null|false|0)\b/i.test(source)) score -= 80;
    if (/cookie:dashboard/.test(source) || /storage:dashboard/.test(source)) score -= 35;
    if (/storage:sidebar/.test(source)) score += 14;
    if (/cookie:sidebar/.test(source)) score += 10;
    if (/performance:any/.test(source)) score += 8;
    if (lectureId && source.includes(`lecture:${lectureId}`)) score += 24;
    return score;
  }

  function parseJsonLike(value) {
    try {
      const text = decodeHtmlEntities(String(value || '')).trim();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function collectUdemyCourseIdsFromObject(obj, add, source, path = '', depth = 0) {
    if (!obj || depth > 8) return;
    if (Array.isArray(obj)) {
      obj.slice(0, 250).forEach((item, index) => collectUdemyCourseIdsFromObject(item, add, source, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof obj !== 'object') return;

    for (const [key, value] of Object.entries(obj)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (/^(courseId|course_id)$/i.test(key)) add(value, `${source}:${nextPath}`);
      if (/courseTakingHeader/i.test(key) && value && typeof value === 'object') {
        add(value.courseId || value.course_id, `${source}:${nextPath}.courseId`);
      }
      if (/^course$/i.test(key) && value && typeof value === 'object') {
        add(value.id || value.courseId || value.course_id, `${source}:${nextPath}.id`);
      }
      collectUdemyCourseIdsFromObject(value, add, source, nextPath, depth + 1);
    }
  }

  function addUdemyCourseIdsFromText(text, add, source, lectureId = '') {
    const raw = String(text || '');
    if (!raw) return;
    const decoded = decodeHtmlEntities(raw);
    const patterns = [
      [lectureId ? new RegExp(`subscribed-courses/(\\d{4,})/lectures/${lectureId}(?:/|\\?|$)`, 'ig') : /a^/g, `${source}:subscribed-course:lecture:${lectureId}`],
      [/subscribed-courses\/(\d{4,})\/lectures\/(\d{4,})/ig, `${source}:subscribed-course`],
      [/"courseTakingHeader"\s*:\s*\{[^}]*"courseId"\s*:\s*(\d{4,})/ig, `${source}:courseTakingHeader`],
      [/\bcourseId["'\s:=]+(\d{4,})/ig, `${source}:courseId`],
      [/\bcourse_id["'\s:=]+(\d{4,})/ig, `${source}:course_id`]
    ];
    for (const [re, label] of patterns) {
      for (const match of decoded.matchAll(re)) add(match[1], label);
    }
  }

  function getUdemyNumericCourseCandidates() {
    const byId = new Map();
    const lectureId = extractUdemyLectureId();
    const add = (value, source = '') => {
      const id = String(value || '').trim();
      if (!/^\d{4,}$/.test(id)) return;
      const current = byId.get(id);
      const item = { id, source: source || 'unknown' };
      if (!current || scoreUdemyCourseCandidate(item, lectureId) > scoreUdemyCourseCandidate(current, lectureId)) byId.set(id, item);
    };

    try {
      const url = new URL(location.href);
      for (const key of ['courseId', 'course_id']) add(url.searchParams.get(key), `url:${key}`);
    } catch {}

    try {
      const entries = performance.getEntriesByType?.('resource') || [];
      for (const entry of entries) {
        const name = String(entry.name || '');
        const exact = lectureId ? name.match(new RegExp(`subscribed-courses/(\\d{4,})/lectures/${lectureId}(?:/|\\?|$)`, 'i')) : null;
        if (exact) add(exact[1], `performance:exact:lecture:${lectureId}`);
        const any = name.match(/subscribed-courses\/(\d{4,})\/lectures\/(\d{4,})/i);
        if (any) add(any[1], `performance:any:lecture:${any[2]}`);
      }
    } catch {}

    try {
      const cookie = document.cookie || '';
      for (const match of cookie.matchAll(/(?:^|;\s*)sidebar_content_(\d{4,})=([^;]*)/g)) {
        const state = decodeURIComponent(match[2] || '') || 'unknown';
        // sidebar_content_<id>=none is frequently stale and not the current course.
        // Keep it as a weak candidate only if no better source exists.
        add(match[1], `cookie:sidebar:${state}`);
      }
      for (const match of cookie.matchAll(/(?:^|;\s*)dashboard_tab_(\d{4,})=([^;]*)/g)) {
        add(match[1], `cookie:dashboard:${decodeURIComponent(match[2] || '') || 'unknown'}`);
      }
      addUdemyCourseIdsFromText(cookie, add, 'cookie:text', lectureId);
    } catch {}

    try {
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i) || '';
          const value = storage.getItem(key) || '';
          const joined = `${key}=${value}`;
          for (const match of joined.matchAll(/sidebar_content_(\d{4,})=?(\w*)/g)) add(match[1], `storage:sidebar:${match[2] || 'unknown'}`);
          for (const match of joined.matchAll(/dashboard_tab_(\d{4,})=?(\w*)/g)) add(match[1], `storage:dashboard:${match[2] || 'unknown'}`);
          addUdemyCourseIdsFromText(joined, add, 'storage:text', lectureId);
          const json = parseJsonLike(value);
          if (json) collectUdemyCourseIdsFromObject(json, add, `storage-json:${key}`);
        }
      }
    } catch {}

    try {
      const attrs = [
        'data-course-id',
        'data-courseid',
        'data-purpose-course-id',
        'data-course-taking-course-id'
      ];
      for (const attr of attrs) {
        document.querySelectorAll(`[${attr}]`).forEach((el) => add(el.getAttribute(attr), `dom:${attr}`));
      }
    } catch {}

    try {
      document.querySelectorAll('[data-module-args], [data-module-props], [data-component-props]').forEach((el) => {
        for (const attr of ['data-module-args', 'data-module-props', 'data-component-props']) {
          const value = el.getAttribute(attr);
          if (!value) continue;
          addUdemyCourseIdsFromText(value, add, `module-args:${attr}`, lectureId);
          const json = parseJsonLike(value);
          if (json) collectUdemyCourseIdsFromObject(json, add, `module-args:${attr}`);
        }
      });
    } catch {}

    try {
      document.querySelectorAll('script').forEach((script, index) => {
        const text = (script.textContent || '').slice(0, 1_500_000);
        if (!/course|lecture|curriculum|subscribed-courses/i.test(text)) return;
        addUdemyCourseIdsFromText(text, add, `script:${index}`, lectureId);
        const json = parseJsonLike(text);
        if (json) collectUdemyCourseIdsFromObject(json, add, `script-json:${index}`);
      });
    } catch {}

    try {
      const html = (document.documentElement?.innerHTML || document.body?.innerHTML || '').slice(0, 5_000_000);
      addUdemyCourseIdsFromText(html, add, 'html', lectureId);
    } catch {}

    const candidates = Array.from(byId.values())
      .map((item) => ({ ...item, score: scoreUdemyCourseCandidate(item, lectureId) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (settings.debug) log('[Udemy] courseId candidates', candidates);
    return candidates;
  }

  function buildUdemyApiHeaders(extra = {}) {
    const headers = {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      ...extra
    };
    const cookieToHeader = {
      ud_cache_brand: 'x-udemy-cache-brand',
      ud_cache_campaign_code: 'x-udemy-cache-campaign-code',
      ud_cache_device: 'x-udemy-cache-device',
      ud_cache_language: 'x-udemy-cache-language',
      ud_cache_logged_in: 'x-udemy-cache-logged-in',
      ud_cache_marketplace_country: 'x-udemy-cache-marketplace-country',
      ud_cache_price_country: 'x-udemy-cache-price-country',
      ud_cache_release: 'x-udemy-cache-release',
      ud_cache_user: 'x-udemy-cache-user',
      ud_cache_version: 'x-udemy-cache-version'
    };
    for (const [cookieName, headerName] of Object.entries(cookieToHeader)) {
      const value = getCookieValue(cookieName);
      if (value && !headers[headerName]) headers[headerName] = value;
    }
    return headers;
  }

  function extractUdemyCourseId() {
    return getUdemyNumericCourseCandidates()[0]?.id || '';
  }

  function hashString(str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function normalizeText(text) {
    return decodeHtmlEntities(String(text || ''))
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function decodeHtmlEntities(text) {
    if (!/[&<>]/.test(text)) return text;
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const STUDY_PARTICLES = [
    'について', 'として', 'によって', 'にとって', 'だけど', 'けれど', 'くらい', 'ぐらい',
    'なんか', 'なんて', 'まで', 'から', 'より', 'ほど', 'だけ', 'しか', 'って', 'とは',
    'では', 'には', 'ても', 'でも', 'たり', 'だり', 'など', 'のに', 'ので', 'ながら',
    'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'も', 'の', 'や', 'か', 'ね', 'よ', 'な'
  ].sort((a, b) => b.length - a.length);

  const STUDY_AUXILIARIES = [
    'ませんでした', 'ません', 'ました', 'ましょう', 'ます', 'でした', 'です', 'でしょう',
    'だった', 'だろう', 'じゃない', 'ではない', 'ない', 'たい', 'られる', 'れる', 'せる',
    'させる', 'そう', 'よう', 'みたい', 'なの', 'だ', 'た', 'て', 'で'
  ].sort((a, b) => b.length - a.length);

  const STUDY_SUFFIXES = new Set(['さん', 'ちゃん', 'くん', '君', '様', 'さま', '先生', '先輩', '氏']);
  const STUDY_PUNCT_RE = /^[、。！？!?.,:;…「」『』（）()\[\]【】〜～ー・]+/;
  const STUDY_ASCII_RE = /^[A-Za-z0-9_+\-./:#@%]+/;
  const STUDY_KATAKANA_RE = /^[\u30a0-\u30ffー]+/;
  const STUDY_HIRAGANA_KANJI_NAME_RE = /^[\u3040-\u309f]+[\u4e00-\u9fff々〆ヶ]+/;
  const STUDY_KANJI_WITH_OKURIGANA_RE = /^[\u4e00-\u9fff々〆ヶ]+[\u3040-\u309f]*/;
  const STUDY_HIRAGANA_RE = /^[\u3040-\u309f]+/;

  const STUDY_ROLE_LABELS = {
    noun: 'noun / danh từ',
    verb: 'verb / động từ',
    particle: 'particle / trợ từ',
    adjective: 'adjective / tính từ',
    auxiliary: 'auxiliary / trợ động từ / đuôi câu',
    adverb: 'adverb / phó từ',
    expression: 'expression / cụm diễn đạt',
    symbol: 'symbol / dấu câu',
    other: 'other / khác'
  };

  const STUDY_READING_MAP = {
    '昨日': 'きのう', '今日': 'きょう', '明日': 'あした', '私': 'わたし', '僕': 'ぼく', '俺': 'おれ',
    '何': 'なに', '家': 'いえ', '人': 'ひと', '日本': 'にほん', '日本語': 'にほんご', '学校': 'がっこう',
    '先生': 'せんせい', '友達': 'ともだち', '大丈夫': 'だいじょうぶ', '心配': 'しんぱい',
    '電車': 'でんしゃ', '車': 'くるま', '映画': 'えいが', '勉強': 'べんきょう', '会話': 'かいわ',
    '食べ': 'たべ', '食べる': 'たべる', '食べた': 'たべた', '食べました': 'たべました',
    '飲み': 'のみ', '飲む': 'のむ', '行く': 'いく', '行きます': 'いきます', '来る': 'くる',
    '見る': 'みる', '見ます': 'みます', '聞く': 'きく', '言う': 'いう', '話す': 'はなす',
    '思う': 'おもう', '乗る': 'のる', '乗っ': 'のっ', '乗って': 'のって', '帰る': 'かえる',
    '買う': 'かう', '読む': 'よむ', '書く': 'かく', '寝る': 'ねる', '起きる': 'おきる',
    '高い': 'たかい', '安い': 'やすい', '良い': 'いい', '悪い': 'わるい', '楽しい': 'たのしい',
    '新しい': 'あたらしい', '古い': 'ふるい', '面白い': 'おもしろい', '難しい': 'むずかしい'
  };

  const STUDY_GLOSS_MAP = {
    '昨日': 'hôm qua', '今日': 'hôm nay', '明日': 'ngày mai', '私': 'tôi', '僕': 'tôi/tớ',
    '何': 'gì', '家': 'nhà', '日本語': 'tiếng Nhật', '大丈夫': 'ổn / không sao', '心配': 'lo lắng',
    'タクシー': 'taxi', '食べる': 'ăn', '食べました': 'đã ăn', '乗る': 'lên / đi xe', '乗って': 'lên / đi xe',
    'です': 'lịch sự / là', 'ます': 'đuôi lịch sự', 'ました': 'quá khứ lịch sự', 'ない': 'phủ định',
    'は': 'topic', 'が': 'chủ ngữ', 'を': 'tân ngữ', 'に': 'tới / vào / cho', 'で': 'tại / bằng', 'の': 'sở hữu / danh hóa',
    'なんか': 'kiểu như / mấy thứ như', 'って': 'rằng / người ta nói / topic thân mật'
  };

  const STUDY_READING_MAP_EXTRA = {
    '別': 'べつ', '別に': 'べつに', '気まずい': 'きまずい', '気まずいこと': 'きまずいこと',
    '何も': 'なにも', '同じ': 'おなじ', '階': 'かい', '同じ階': 'おなじかい',
    '行き来': 'いきき', '行き来する': 'いききする', '間': 'あいだ', '間に': 'あいだに',
    '大丈夫なの': 'だいじょうぶなの', '必要': 'ひつよう', '好き': 'すき', '嫌い': 'きらい',
    '便利': 'べんり', '有名': 'ゆうめい', '静か': 'しずか', '元気': 'げんき', '上手': 'じょうず',
    '下手': 'へた', '大切': 'たいせつ', '時間': 'じかん', '場合': 'ばあい', '問題': 'もんだい',
    '意味': 'いみ', '本当': 'ほんとう', '全部': 'ぜんぶ', '一緒': 'いっしょ', '自分': 'じぶん',
    '相手': 'あいて', '仕事': 'しごと', '会社': 'かいしゃ', '部屋': 'へや', '場所': 'ばしょ',
    '世界': 'せかい', '名前': 'なまえ', '電話': 'でんわ', '番号': 'ばんごう', '料理': 'りょうり',
    '写真': 'しゃしん', '音楽': 'おんがく', '漫画': 'まんが', '動画': 'どうが', '字幕': 'じまく',
    '翻訳': 'ほんやく', '日本人': 'にほんじん', '外国': 'がいこく', '外国人': 'がいこくじん',
    '英語': 'えいご', '中国語': 'ちゅうごくご', '韓国語': 'かんこくご', '勉強する': 'べんきょうする',
    '話して': 'はなして', '言って': 'いって', '思って': 'おもって', '見て': 'みて', '聞いて': 'きいて',
    '帰って': 'かえって', '買って': 'かって', '読んで': 'よんで', '書いて': 'かいて', '寝て': 'ねて',
    '起きて': 'おきて', '分かる': 'わかる', '分かります': 'わかります', '分かった': 'わかった',
    '分かって': 'わかって', '入る': 'はいる', '入って': 'はいって', '出る': 'でる', '出て': 'でて',
    '作る': 'つくる', '作って': 'つくって', '使う': 'つかう', '使って': 'つかって', '持つ': 'もつ',
    '持って': 'もって', '待つ': 'まつ', '待って': 'まって', '笑う': 'わらう', '笑って': 'わらって',
    '泣く': 'なく', '泣いて': 'ないて', '死ぬ': 'しぬ', '死んで': 'しんで', '生きる': 'いきる',
    '生きて': 'いきて', '違う': 'ちがう', '違って': 'ちがって', '近い': 'ちかい', '遠い': 'とおい',
    '早い': 'はやい', '遅い': 'おそい', '長い': 'ながい', '短い': 'みじかい', '小さい': 'ちいさい',
    '大きい': 'おおきい', '可愛い': 'かわいい', '怖い': 'こわい', '忙しい': 'いそがしい',
    '美味しい': 'おいしい', '多い': 'おおい', '少ない': 'すくない', '強い': 'つよい', '弱い': 'よわい'
  };
  Object.assign(STUDY_READING_MAP, STUDY_READING_MAP_EXTRA);

  const STUDY_GLOSS_MAP_EXTRA = {
    '別に': 'không hẳn / cũng không có gì', '気まずい': 'ngượng / khó xử', '気まずいこと': 'chuyện khó xử',
    '何も': 'không có gì', '同じ': 'giống nhau / cùng', '階': 'tầng', '行き来': 'đi qua đi lại',
    '行き来する': 'đi qua đi lại', '間': 'trong lúc / khoảng giữa', '間に': 'trong lúc',
    '必要': 'cần thiết', '好き': 'thích', '嫌い': 'ghét', '便利': 'tiện lợi', '有名': 'nổi tiếng',
    '静か': 'yên tĩnh', '元気': 'khỏe / năng lượng', '仕事': 'công việc', '会社': 'công ty',
    '時間': 'thời gian', '問題': 'vấn đề', '意味': 'ý nghĩa', '本当': 'thật sự', '自分': 'bản thân',
    '字幕': 'phụ đề', '翻訳': 'dịch', '勉強': 'học', '話す': 'nói chuyện', '分かる': 'hiểu',
    '入る': 'vào', '出る': 'ra', '作る': 'làm / tạo', '使う': 'dùng', '待つ': 'đợi', '違う': 'khác / sai'
  };
  Object.assign(STUDY_GLOSS_MAP, STUDY_GLOSS_MAP_EXTRA);


  function katakanaToHiragana(text) {
    return String(text || '').replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

  function looksJapanese(text) {
    return /[\u3040-\u30ff\u4e00-\u9fff々〆ヶ]/.test(String(text || ''));
  }

  function isKanaOnly(text) {
    return /^[\u3040-\u30ffー]+$/.test(String(text || ''));
  }


  function containsKanji(text) {
    return /[\u4e00-\u9fff々〆ヶ]/.test(String(text || ''));
  }

  function normalizeKanaForCompare(text) {
    return katakanaToHiragana(String(text || '')).replace(/\s+/g, '');
  }

  function shouldInlineFurigana(chunk, speakingState) {
    if (!settings.studyFurigana) return false;
    const display = settings.studyFuriganaDisplay || 'kanji';
    if (display === 'hover') return false;
    if (display === 'current') {
      const state = speakingState?.classes?.get(chunk.chunkId) || '';
      return state === 'current';
    }
    return true;
  }

  function canUseKuromoji() {
    const engine = settings.studyFuriganaEngine || 'auto';
    return engine !== 'lightweight' && Boolean(settings.studyMode && settings.studyFurigana);
  }

  function ensureKuromojiTokenizer() {
    if (!canUseKuromoji()) return null;
    if (kuromojiTokenizer) return Promise.resolve(kuromojiTokenizer);
    if (kuromojiFailed) return null;
    if (kuromojiTokenizerPromise) return kuromojiTokenizerPromise;
    if (!globalThis.kuromoji?.builder) {
      kuromojiFailed = true;
      kuromojiStatus = 'missing';
      return null;
    }
    kuromojiStatus = 'loading';
    const dicPath = chrome.runtime.getURL('vendor/kuromoji/dict/');
    kuromojiTokenizerPromise = new Promise((resolve, reject) => {
      try {
        globalThis.kuromoji.builder({ dicPath }).build((err, tokenizer) => {
          if (err || !tokenizer) {
            kuromojiFailed = true;
            kuromojiStatus = 'failed';
            reject(err || new Error('Kuromoji tokenizer failed to build'));
            return;
          }
          kuromojiTokenizer = tokenizer;
          kuromojiStatus = 'ready';
          studyAnalysisCache.clear();
          renderNow(true);
          resolve(tokenizer);
        });
      } catch (err) {
        kuromojiFailed = true;
        kuromojiStatus = 'failed';
        reject(err);
      }
    }).catch((err) => {
      console.warn('[YT-Translator] Kuromoji failed, using lightweight analyzer:', err);
      return null;
    });
    return kuromojiTokenizerPromise;
  }

  function mapKuromojiPos(token) {
    const pos = token?.pos || '';
    if (pos === '名詞') return 'noun';
    if (pos === '動詞') return 'verb';
    if (pos === '形容詞') return 'adjective';
    if (pos === '助詞') return 'particle';
    if (pos === '助動詞') return 'auxiliary';
    if (pos === '副詞') return 'adverb';
    if (pos === '記号') return 'symbol';
    if (pos === '感動詞' || pos === '接続詞' || pos === '連体詞') return 'expression';
    return 'other';
  }

  function normalizeKuromojiReading(token) {
    const surface = token?.surface_form || token?.surface || '';
    const raw = token?.reading && token.reading !== '*' ? token.reading : '';
    const hira = raw ? katakanaToHiragana(raw) : getStudyReading(surface);
    if (!hira || hira === '*' || normalizeKanaForCompare(hira) === normalizeKanaForCompare(surface)) return '';
    return hira;
  }

  function tokenizeJapaneseWithKuromoji(text) {
    if (!kuromojiTokenizer) return null;
    try {
      const rawTokens = kuromojiTokenizer.tokenize(normalizeText(text));
      return rawTokens.map((t) => {
        const surface = String(t.surface_form || '');
        const role = mapKuromojiPos(t);
        const reading = normalizeKuromojiReading(t);
        const lemma = t.basic_form && t.basic_form !== '*' ? t.basic_form : surface;
        return {
          surface,
          lemma,
          reading,
          role,
          pos: [t.pos, t.pos_detail_1, t.pos_detail_2, t.pos_detail_3].filter((x) => x && x !== '*').join(' / '),
          conjugation: [t.conjugated_type, t.conjugated_form].filter((x) => x && x !== '*').join(' / '),
          gloss: getStudyGloss(surface, role) || getStudyGloss(lemma, role),
          startChar: -1,
          endChar: -1,
          analyzer: 'kuromoji'
        };
      }).filter((t) => t.surface);
    } catch (err) {
      console.warn('[YT-Translator] Kuromoji tokenize failed:', err);
      return null;
    }
  }

  function smartRubyHtml(surface, reading) {
    const s = String(surface || '');
    const r = normalizeKanaForCompare(reading);
    if (!s || !r || !containsKanji(s)) return escapeHtml(s);
    const chars = Array.from(s);
    const firstKanji = chars.findIndex((ch) => containsKanji(ch));
    const lastKanji = (() => {
      for (let i = chars.length - 1; i >= 0; i -= 1) if (containsKanji(chars[i])) return i;
      return -1;
    })();
    if (firstKanji < 0 || lastKanji < 0) return escapeHtml(s);
    const prefix = chars.slice(0, firstKanji).join('');
    const core = chars.slice(firstKanji, lastKanji + 1).join('');
    const suffix = chars.slice(lastKanji + 1).join('');
    const prefixH = normalizeKanaForCompare(prefix);
    const suffixH = normalizeKanaForCompare(suffix);
    let coreReading = r;
    if (prefixH && coreReading.startsWith(prefixH)) coreReading = coreReading.slice(prefixH.length);
    else if (prefixH) return `<ruby>${escapeHtml(s)}<rt>${escapeHtml(r)}</rt></ruby>`;
    if (suffixH && coreReading.endsWith(suffixH)) coreReading = coreReading.slice(0, -suffixH.length);
    else if (suffixH) return `<ruby>${escapeHtml(s)}<rt>${escapeHtml(r)}</rt></ruby>`;
    if (!coreReading) return `<ruby>${escapeHtml(s)}<rt>${escapeHtml(r)}</rt></ruby>`;
    return `${escapeHtml(prefix)}<ruby>${escapeHtml(core)}<rt>${escapeHtml(coreReading)}</rt></ruby>${escapeHtml(suffix)}`;
  }

  function getStudyReading(surface) {
    const s = String(surface || '');
    if (!s || !/[\u4e00-\u9fff々〆ヶ]/.test(s)) return '';
    if (STUDY_READING_MAP[s]) return STUDY_READING_MAP[s];
    // If a known stem is followed by kana inflection, combine the known reading with the kana tail.
    const entries = Object.keys(STUDY_READING_MAP).sort((a, b) => b.length - a.length);
    for (const key of entries) {
      if (s.startsWith(key) && s.length > key.length) {
        const tail = s.slice(key.length);
        if (/^[\u3040-\u309f]+$/.test(tail)) return STUDY_READING_MAP[key] + tail;
      }
    }
    return '';
  }

  function getStudyGloss(surface, role) {
    const s = String(surface || '');
    if (STUDY_GLOSS_MAP[s]) return STUDY_GLOSS_MAP[s];
    const normalized = s.replace(/(ました|ます|ない|て|た|だ|です|なの)$/u, '');
    if (normalized && STUDY_GLOSS_MAP[normalized]) return STUDY_GLOSS_MAP[normalized];
    if (role === 'particle') return 'trợ từ';
    if (role === 'auxiliary') return 'đuôi câu / trợ động từ';
    return '';
  }

  function classifyJapaneseToken(surface, hint = '') {
    const s = String(surface || '');
    if (!s) return 'other';
    if (STUDY_PUNCT_RE.test(s)) return 'symbol';
    if (STUDY_PARTICLES.includes(s)) return 'particle';
    if (STUDY_AUXILIARIES.includes(s)) return 'auxiliary';
    if (STUDY_SUFFIXES.has(s)) return 'noun';
    if (/^(とても|すごく|もう|まだ|よく|ちょっと|だんだん|いつも|ぜんぜん|全然)$/.test(s)) return 'adverb';
    if (/大丈夫|心配|必要|好き|嫌い|便利|有名|静か|元気|上手|下手|大切/.test(s)) return 'adjective';
    if (/い$/.test(s) && /[\u3040-\u309f]$/.test(s) && s.length > 1) return 'adjective';
    if (/(ます|ました|ません|ない|たい|て|で|た|だ|る|う|く|ぐ|す|つ|ぬ|ぶ|む)$/.test(s) && /[\u3040-\u309f]/.test(s)) return 'verb';
    if (hint === 'katakana' || /[\u4e00-\u9fff々〆ヶ]/.test(s) || /^[\u30a0-\u30ffー]+$/.test(s)) return 'noun';
    return 'other';
  }

  function pushStudyToken(tokens, surface, roleHint = '') {
    if (!surface) return;
    const role = roleHint || classifyJapaneseToken(surface);
    const reading = getStudyReading(surface);
    const gloss = getStudyGloss(surface, role);
    tokens.push({ surface, lemma: surface, reading, role, gloss, startChar: -1, endChar: -1 });
  }

  function tokenizeJapaneseStudy(text) {
    const src = normalizeText(text);
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);
      const ws = rest.match(/^\s+/);
      if (ws) { i += ws[0].length; continue; }

      const punct = rest.match(STUDY_PUNCT_RE);
      if (punct) { pushStudyToken(tokens, punct[0], 'symbol'); i += punct[0].length; continue; }

      const ascii = rest.match(STUDY_ASCII_RE);
      if (ascii) { pushStudyToken(tokens, ascii[0], 'other'); i += ascii[0].length; continue; }

      const particle = STUDY_PARTICLES.find((p) => rest.startsWith(p));
      if (particle) { pushStudyToken(tokens, particle, 'particle'); i += particle.length; continue; }

      const aux = STUDY_AUXILIARIES.find((a) => rest.startsWith(a));
      if (aux) { pushStudyToken(tokens, aux, 'auxiliary'); i += aux.length; continue; }

      const name = rest.match(STUDY_HIRAGANA_KANJI_NAME_RE);
      if (name) { pushStudyToken(tokens, name[0], 'noun'); i += name[0].length; continue; }

      const kata = rest.match(STUDY_KATAKANA_RE);
      if (kata) { pushStudyToken(tokens, kata[0], 'noun'); i += kata[0].length; continue; }

      const kanji = rest.match(STUDY_KANJI_WITH_OKURIGANA_RE);
      if (kanji) { pushStudyToken(tokens, kanji[0]); i += kanji[0].length; continue; }

      const hira = rest.match(STUDY_HIRAGANA_RE);
      if (hira) { pushStudyToken(tokens, hira[0]); i += hira[0].length; continue; }

      pushStudyToken(tokens, rest[0], 'other');
      i += 1;
    }
    return tokens;
  }

  function assignStudyTokenRanges(text, tokens) {
    const src = normalizeText(text);
    let cursor = 0;
    return tokens.map((token) => {
      const surface = String(token.surface || '');
      let start = src.indexOf(surface, cursor);
      if (start < 0) {
        start = cursor;
      }
      const end = Math.min(src.length, start + surface.length);
      cursor = Math.max(cursor, end);
      return { ...token, startChar: start, endChar: end };
    });
  }

  function mergeStudyTokens(tokens) {
    if (!settings.studyChunkMode) return tokens.map((t, index) => ({ ...t, chunkId: index }));
    const chunks = [];
    const clone = (t) => ({ ...t });
    for (let i = 0; i < tokens.length; i += 1) {
      let current = clone(tokens[i]);
      current.tokens = [tokens[i]];

      // Honorific/name chunks: Nobita + san/chan/kun.
      if (current.role === 'noun' && tokens[i + 1] && STUDY_SUFFIXES.has(tokens[i + 1].surface)) {
        const next = tokens[i + 1];
        current.surface += next.surface;
        current.tokens.push(next);
        current.role = 'noun';
        i += 1;
      }

      // Verb/adjective chunks with common endings.
      while (tokens[i + 1] && (current.role === 'verb' || current.role === 'adjective') && ['auxiliary', 'particle'].includes(tokens[i + 1].role)) {
        const n = tokens[i + 1];
        if (!/^(て|で|た|ます|ました|ません|ない|たい|そう|よう|の|な|だ|です|か|ね|よ)$/.test(n.surface)) break;
        current.surface += n.surface;
        current.tokens.push(n);
        i += 1;
      }

      // Noun + copula/nominalizer chunk such as 大丈夫なの, 先生です.
      while (tokens[i + 1] && current.role === 'noun' && ['auxiliary', 'particle'].includes(tokens[i + 1].role)) {
        const n = tokens[i + 1];
        if (!/^(な|の|だ|です|だった|でした|か|ね|よ)$/.test(n.surface)) break;
        current.surface += n.surface;
        current.tokens.push(n);
        current.role = /大丈夫|心配|必要|好き|嫌い|便利|有名|静か|元気|上手|下手|大切/.test(current.surface) ? 'adjective' : 'noun';
        i += 1;
      }

      // Particle emphasis chunks like タクシー + なんか.
      if (current.role === 'noun' && tokens[i + 1] && /^(なんか|なんて|など|だけ|まで|から)$/.test(tokens[i + 1].surface)) {
        const next = tokens[i + 1];
        current.surface += next.surface;
        current.tokens.push(next);
        current.role = 'noun';
        i += 1;
      }

      const ranges = current.tokens.filter((t) => Number.isFinite(t.startChar) && t.startChar >= 0);
      if (ranges.length) {
        current.startChar = Math.min(...ranges.map((t) => t.startChar));
        current.endChar = Math.max(...ranges.map((t) => t.endChar));
      }

      const readingParts = current.tokens.map((t) => t.reading).filter(Boolean);
      current.reading = readingParts.length ? readingParts.join('') : getStudyReading(current.surface);
      current.gloss = getStudyGloss(current.surface, current.role) || current.tokens.map((t) => t.gloss).filter(Boolean).join(' / ');
      chunks.push({ ...current, chunkId: chunks.length });
    }
    return chunks;
  }

  function analyzeJapaneseStudyText(text) {
    const normalized = normalizeText(text);
    const engine = settings.studyFuriganaEngine || 'auto';
    const style = settings.studyFuriganaStyle || 'smart';
    const useKuro = canUseKuromoji() && engine !== 'lightweight';
    const cacheKey = `study-v3:${useKuro && kuromojiTokenizer ? 'kuromoji' : 'lightweight'}:${style}:${normalized}`;
    if (studyAnalysisCache.has(cacheKey)) return studyAnalysisCache.get(cacheKey);

    let tokens = null;
    let analyzer = 'lightweight';
    if (useKuro && kuromojiTokenizer) {
      tokens = tokenizeJapaneseWithKuromoji(normalized);
      if (tokens && tokens.length) analyzer = 'kuromoji';
    } else if (useKuro) {
      ensureKuromojiTokenizer();
    }

    if (!tokens || !tokens.length) {
      tokens = tokenizeJapaneseStudy(normalized).map((t) => ({ ...t, analyzer: 'lightweight' }));
      analyzer = 'lightweight';
    }

    tokens = assignStudyTokenRanges(normalized, tokens);
    const chunks = mergeStudyTokens(tokens);
    const analysis = { tokens, chunks, analyzer, kuromojiStatus };
    studyAnalysisCache.set(cacheKey, analysis);
    if (studyAnalysisCache.size > 900) {
      const first = studyAnalysisCache.keys().next().value;
      studyAnalysisCache.delete(first);
    }
    return analysis;
  }

  function buildStudyTooltip(chunk) {
    if (!settings.studyTooltips) return '';
    const lines = [];
    lines.push(chunk.surface);
    if (chunk.reading) lines.push(`reading: ${katakanaToHiragana(chunk.reading)}`);
    if (chunk.lemma && chunk.lemma !== chunk.surface) lines.push(`lemma: ${chunk.lemma}`);
    lines.push(`type: ${STUDY_ROLE_LABELS[chunk.role] || chunk.role}`);
    if (chunk.pos) lines.push(`pos: ${chunk.pos}`);
    if (chunk.gloss) lines.push(`meaning: ${chunk.gloss}`);
    if (chunk.analyzer) lines.push(`analyzer: ${chunk.analyzer}`);
    return lines.join('\n');
  }

  function renderTokenWithFurigana(token, chunk, speakingState) {
    const surface = String(token?.surface || '');
    if (!surface) return '';
    const reading = katakanaToHiragana(token?.reading || getStudyReading(surface));
    const show = shouldInlineFurigana(chunk, speakingState) && containsKanji(surface) && reading && normalizeKanaForCompare(reading) !== normalizeKanaForCompare(surface);
    if (!show) return escapeHtml(surface);
    if ((settings.studyFuriganaStyle || 'smart') === 'basic') {
      return `<ruby>${escapeHtml(surface)}<rt>${escapeHtml(reading)}</rt></ruby>`;
    }
    return smartRubyHtml(surface, reading);
  }

  function renderStudyChunkContent(chunk, speakingState) {
    const tokens = Array.isArray(chunk.tokens) && chunk.tokens.length ? chunk.tokens : [chunk];
    const html = tokens.map((token) => renderTokenWithFurigana(token, chunk, speakingState)).join('');
    if (html && html !== escapeHtml(chunk.surface)) return html;
    const reading = katakanaToHiragana(chunk.reading || getStudyReading(chunk.surface));
    if (shouldInlineFurigana(chunk, speakingState) && containsKanji(chunk.surface) && reading) {
      return (settings.studyFuriganaStyle || 'smart') === 'basic'
        ? `<ruby>${escapeHtml(chunk.surface)}<rt>${escapeHtml(reading)}</rt></ruby>`
        : smartRubyHtml(chunk.surface, reading);
    }
    return escapeHtml(chunk.surface);
  }

  function renderStudyChunk(chunk, speakingState = null) {
    const role = chunk.role || 'other';
    const title = buildStudyTooltip(chunk);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const content = renderStudyChunkContent(chunk, speakingState);
    // Karaoke progress is applied to the whole subtitle line. Do not attach
    // spoken/current/upcoming classes to individual chunks; that made the UI
    // look like tokenizer-debug and highlighted only tiny pieces in practice.
    const analyzerClass = chunk.analyzer === 'kuromoji' || chunk.tokens?.some?.((t) => t.analyzer === 'kuromoji') ? ' ytort-study-kuromoji' : ' ytort-study-lightweight';
    return `<span class="ytort-study-chunk ytort-study-${role}${analyzerClass}"${titleAttr}>${content}</span>`;
  }

  function renderStudyTokenInline(token, speakingState = null) {
    const role = token?.role || 'other';
    const title = buildStudyTooltip(token || {});
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const content = renderTokenWithFurigana(token, token, speakingState);
    const analyzerClass = token?.analyzer === 'kuromoji' ? ' ytort-study-kuromoji' : ' ytort-study-lightweight';
    return `<span class="ytort-study-token ytort-study-token-${role}${analyzerClass}"${titleAttr}>${content}</span>`;
  }

  function renderStudyLineContent(analysis, speakingState = null) {
    if (settings.studyChunkMode) {
      return analysis.chunks.map((chunk) => renderStudyChunk(chunk, speakingState)).join('');
    }
    const tokens = Array.isArray(analysis.tokens) && analysis.tokens.length
      ? analysis.tokens
      : analysis.chunks.flatMap((chunk) => Array.isArray(chunk.tokens) && chunk.tokens.length ? chunk.tokens : [chunk]);
    return tokens.map((token) => renderStudyTokenInline(token, speakingState)).join('');
  }

  function isStudySpeakingEnabled(text) {
    return Boolean(settings.studyMode && settings.studyHighlight && settings.studySpeakingHighlight && looksJapanese(text));
  }

  function buildCueTimingSegments(cue) {
    const cueText = normalizeText(cue?.text || '');
    const rawSegments = Array.isArray(cue?.timingSegments) ? cue.timingSegments : [];
    if (!cueText || rawSegments.length < 2) return [];

    const rawStart = getCueRawStart(cue);
    const rawEnd = getCueRawEnd(cue);
    return rawSegments
      .map((seg) => ({
        start: Number(seg.start),
        end: Number(seg.end),
        startChar: Number(seg.startChar),
        endChar: Number(seg.endChar),
        text: String(seg.text || '')
      }))
      .filter((seg) => (
        Number.isFinite(seg.start) &&
        Number.isFinite(seg.end) &&
        seg.end > seg.start &&
        seg.start >= rawStart - 0.25 &&
        seg.end <= rawEnd + 0.75 &&
        Number.isFinite(seg.startChar) &&
        Number.isFinite(seg.endChar) &&
        seg.endChar > seg.startChar &&
        seg.startChar >= 0 &&
        seg.endChar <= cueText.length + 2
      ));
  }

  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }

  function buildRealChunkTimings(cue, analysis) {
    const segments = buildCueTimingSegments(cue);
    if (!segments.length) return [];
    const timings = [];

    for (const chunk of analysis.chunks) {
      if (chunk.role === 'symbol') continue;
      const cStart = Number(chunk.startChar);
      const cEnd = Number(chunk.endChar);
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd) || cEnd <= cStart) continue;
      const matching = segments.filter((seg) => rangesOverlap(cStart, cEnd, seg.startChar, seg.endChar) > 0);
      if (!matching.length) continue;
      timings.push({
        chunkId: chunk.chunkId,
        start: Math.min(...matching.map((seg) => seg.start)),
        end: Math.max(...matching.map((seg) => seg.end)),
        source: 'real'
      });
    }

    // Require enough real timings to trust the cursor. If only one chunk maps to
    // real timing, use length-based timing instead.
    return timings.length >= Math.min(2, analysis.chunks.filter((c) => c.role !== 'symbol').length) ? timings : [];
  }

  function buildEstimatedChunkTimings(cue, analysis) {
    const chunks = analysis.chunks.filter((chunk) => chunk.role !== 'symbol');
    const cueStart = getCueProgressStart(cue);
    const cueEnd = Math.max(getCueProgressEnd(cue), cueStart + 0.25);
    const duration = cueEnd - cueStart;
    const weights = chunks.map((chunk) => getTimingTextWeight(chunk.surface || ''));
    const total = weights.reduce((sum, w) => sum + w, 0) || chunks.length || 1;
    let cursor = cueStart;
    return chunks.map((chunk, i) => {
      const len = duration * (weights[i] / total);
      const start = cursor;
      const end = i === chunks.length - 1 ? cueEnd : cursor + len;
      cursor = end;
      return { chunkId: chunk.chunkId, start, end, source: 'estimated' };
    });
  }

  function getStudySpeakingState(cue, analysis, currentTime) {
    if (!isStudySpeakingEnabled(cue?.text || '')) return { key: '', classes: new Map(), activeChunkId: -1 };
    const t = Number(currentTime);
    const timings = buildRealChunkTimings(cue, analysis);
    const finalTimings = timings.length ? timings : buildEstimatedChunkTimings(cue, analysis);
    const classes = new Map();
    let active = null;

    for (const timing of finalTimings) {
      const start = timing.start;
      const end = Math.max(timing.end, start + 0.12);
      if (t >= start - 0.08 && t <= end + 0.08) {
        active = timing;
        break;
      }
      if (t > end + 0.08) classes.set(timing.chunkId, 'spoken');
      else classes.set(timing.chunkId, 'upcoming');
    }

    if (!active && finalTimings.length) {
      active = t < finalTimings[0].start ? finalTimings[0] : finalTimings[finalTimings.length - 1];
    }
    if (active) {
      classes.set(active.chunkId, 'current');
      for (const timing of finalTimings) {
        if (timing.chunkId === active.chunkId) continue;
        if (!classes.has(timing.chunkId)) classes.set(timing.chunkId, timing.end < active.start ? 'spoken' : 'upcoming');
      }
    }

    const activeChunkId = active?.chunkId ?? -1;
    const source = finalTimings[0]?.source || 'none';
    return { key: `${source}:${activeChunkId}`, classes, activeChunkId };
  }

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function getCueRawStart(cue) {
    return Number.isFinite(Number(cue?.rawStart)) ? Number(cue.rawStart) : Number(cue?.start || 0);
  }

  function getCueRawEnd(cue) {
    const start = getCueRawStart(cue);
    const end = Number.isFinite(Number(cue?.rawEnd)) ? Number(cue.rawEnd) : Number(cue?.end || start + 0.25);
    return Math.max(end, start + 0.25);
  }

  function getCueDisplayStart(cue) {
    return Number.isFinite(Number(cue?.displayStart)) ? Number(cue.displayStart) : Number(cue?.start || 0);
  }

  function getCueDisplayEnd(cue) {
    const start = getCueDisplayStart(cue);
    const end = Number.isFinite(Number(cue?.displayEnd)) ? Number(cue.displayEnd) : Number(cue?.end || start + 0.25);
    return Math.max(end, start + 0.25);
  }

  function getCueProgressStart(cue) {
    return Number.isFinite(Number(cue?.progressStart)) ? Number(cue.progressStart) : getCueRawStart(cue);
  }

  function getCueProgressEnd(cue) {
    const start = getCueProgressStart(cue);
    const end = Number.isFinite(Number(cue?.progressEnd)) ? Number(cue.progressEnd) : getCueRawEnd(cue);
    return Math.max(end, start + 0.25);
  }

  function getTimingTextWeight(text) {
    const compact = String(text || '').replace(/[\s、。！？!?.,:;…「」『』（）()\[\]【】〜～ー・]/g, '');
    return Math.max(1, compact.length || String(text || '').length || 1);
  }

  function hasMeaningfulSegmentCoverage(cue, segments) {
    const cueText = normalizeText(cue?.text || '');
    const textWeight = getTimingTextWeight(cueText);
    if (!cueText || !segments.length) return false;
    const covered = new Array(cueText.length).fill(false);
    for (const seg of segments) {
      for (let i = Math.max(0, seg.startChar); i < Math.min(cueText.length, seg.endChar); i += 1) {
        const ch = cueText[i];
        if (!/[\s、。！？!?.,:;…「」『』（）()\[\]【】〜～ー・]/.test(ch)) covered[i] = true;
      }
    }
    const coveredCount = covered.filter(Boolean).length;
    return coveredCount / textWeight >= 0.55;
  }

  function getTimingCacheKey(cue) {
    return `${getCueRawStart(cue)}:${getCueRawEnd(cue)}:${cue?.text || ''}:${Array.isArray(cue?.timingSegments) ? cue.timingSegments.length : 0}`;
  }

  function getReliableTimingSegments(cue) {
    const key = getTimingCacheKey(cue);
    if (cue?._ytortTimingCache?.key === key) return cue._ytortTimingCache.segments || [];

    const segments = buildCueTimingSegments(cue);
    let reliable = segments.length >= 2;
    const rawStart = getCueRawStart(cue);
    const rawEnd = getCueRawEnd(cue);
    const rawDuration = rawEnd - rawStart;
    if (rawDuration < 0.6) reliable = false;

    let previousStart = -Infinity;
    if (reliable) {
      for (const seg of segments) {
        if (seg.start < previousStart - 0.015 || seg.end <= seg.start) {
          reliable = false;
          break;
        }
        previousStart = seg.start;
      }
    }
    if (reliable && !hasMeaningfulSegmentCoverage(cue, segments)) reliable = false;

    const finalSegments = reliable ? segments : [];
    try { cue._ytortTimingCache = { key, segments: finalSegments }; } catch {}
    return finalSegments;
  }

  function isReliableSegmentTiming(cue) {
    return getReliableTimingSegments(cue).length > 0;
  }

  function getSegmentBasedKaraokeProgress(cue, currentTime) {
    const segments = getReliableTimingSegments(cue);
    if (!segments.length) return 0;
    const cueText = normalizeText(cue?.text || '');
    const t = Number(currentTime);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!Number.isFinite(t) || t <= first.start) return 0;
    if (t >= last.end) return 1;

    let current = segments[0];
    for (const seg of segments) {
      if (t >= seg.start && t <= seg.end) {
        current = seg;
        break;
      }
      if (t > seg.end) current = seg;
      if (t < seg.start) break;
    }

    if (t > current.end) {
      const next = segments.find((seg) => seg.start > current.end && t < seg.start);
      if (next) return clamp01(current.endChar / Math.max(1, cueText.length));
    }

    const segDuration = Math.max(0.08, current.end - current.start);
    const segProgress = clamp01((t - current.start) / segDuration);
    const charProgress = current.startChar + (current.endChar - current.startChar) * segProgress;
    return clamp01(charProgress / Math.max(1, cueText.length));
  }

  function getLinearKaraokeProgress(cue, currentTime) {
    const start = getCueProgressStart(cue);
    const end = Math.max(getCueProgressEnd(cue), start + 0.25);
    return clamp01((Number(currentTime) - start) / Math.max(0.25, end - start));
  }

  function getCueKaraokeProgress(cue, currentTime) {
    if (!isStudySpeakingEnabled(cue?.text || '')) return 1;
    if (isReliableSegmentTiming(cue)) return getSegmentBasedKaraokeProgress(cue, currentTime);
    return getLinearKaraokeProgress(cue, currentTime);
  }

  function getCueKaraokeSource(cue) {
    if (!isStudySpeakingEnabled(cue?.text || '')) return 'off';
    return isReliableSegmentTiming(cue) ? 'segment' : 'linear';
  }

  function renderKaraokeLine(contentHtml, progress) {
    const pct = Math.round(clamp01(progress) * 1000) / 10;
    return `
      <span class="ytort-karaoke-wrap" style="--ytort-karaoke-progress:${pct}%">
        <span class="ytort-karaoke-base">${contentHtml}</span>
        <span class="ytort-karaoke-active" aria-hidden="true">${contentHtml}</span>
      </span>
    `;
  }

  function getStudySpeakingKey(cue, currentTime) {
    if (!isStudySpeakingEnabled(cue?.text || '')) return '';
    const bucket = Math.round(getCueKaraokeProgress(cue, currentTime) * 200);
    return `karaoke:${getCueKaraokeSource(cue)}:${bucket}`;
  }

  function renderOriginalSubtitle(originalEl, cueOrText) {
    if (!originalEl) return;
    const cue = typeof cueOrText === 'object' && cueOrText ? cueOrText : { text: String(cueOrText || ''), start: 0, end: 0 };
    const text = cue.text || '';
    if (!settings.showOriginal) {
      originalEl.style.display = 'none';
      originalEl.textContent = '';
      return;
    }
    originalEl.style.display = 'block';
    if (!settings.studyMode || !settings.studyHighlight || !looksJapanese(text)) {
      originalEl.textContent = text || '';
      originalEl.classList.remove('ytort-study-line', 'ytort-study-clean', 'ytort-study-boxes', 'ytort-karaoke-line');
      return;
    }
    const analysis = analyzeJapaneseStudyText(text || '');
    const speakingState = settings.studyFuriganaDisplay === 'current'
      ? getStudySpeakingState(cue, analysis, getCurrentTime())
      : null;
    const contentHtml = renderStudyLineContent(analysis, speakingState);
    originalEl.classList.add('ytort-study-line');
    originalEl.classList.toggle('ytort-study-clean', !settings.studyChunkMode);
    originalEl.classList.toggle('ytort-study-boxes', Boolean(settings.studyChunkMode));
    originalEl.classList.toggle('ytort-karaoke-line', Boolean(settings.studySpeakingHighlight));
    originalEl.innerHTML = settings.studySpeakingHighlight
      ? renderKaraokeLine(contentHtml, getCueKaraokeProgress(cue, getCurrentTime()))
      : contentHtml;
  }

  function isCJK(text) {
    const compact = String(text || '').replace(/\s/g, '');
    if (!compact) return false;
    const cjk = compact.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    return cjk.length / compact.length > 0.35;
  }

  function parseYouTubeJson3(body, payload) {
    const data = JSON.parse(body);
    const events = Array.isArray(data.events) ? data.events : [];
    const tokens = [];
    const filteredEvents = events
      .map((event) => ({
        ...event,
        segs: Array.isArray(event.segs)
          ? event.segs.filter((seg) => normalizeText(seg.utf8) !== '')
          : []
      }))
      .filter((event) => event.segs.length > 0);

    for (let i = 0; i < filteredEvents.length; i += 1) {
      const event = filteredEvents[i];
      const segs = event.segs || [];
      for (let k = 0; k < segs.length; k += 1) {
        const seg = segs[k];
        const startMs = Number(event.tStartMs || 0) + Number(seg.tOffsetMs || 0);
        const nextSeg = segs[k + 1];
        const nextEvent = filteredEvents[i + 1];
        let endMs;
        if (nextSeg) {
          endMs = Number(event.tStartMs || 0) + Number(nextSeg.tOffsetMs || 0);
        } else if (nextEvent) {
          const eventEnd = Number(event.tStartMs || 0) + Number(event.dDurationMs || 0);
          endMs = event.dDurationMs ? Math.min(eventEnd, Number(nextEvent.tStartMs || eventEnd)) : Number(nextEvent.tStartMs || startMs + 2500);
        } else {
          endMs = Number(event.tStartMs || 0) + Number(event.dDurationMs || 2500);
        }
        const text = normalizeText(seg.utf8);
        if (text) {
          tokens.push({ start: startMs / 1000, end: Math.max(endMs / 1000, startMs / 1000 + 0.25), text });
        }
      }
    }
    return tokensToCues(tokens, payload);
  }

  function parseYouTubeXml(body, payload) {
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error('Invalid timedtext XML');
    const nodes = Array.from(doc.querySelectorAll('text'));
    const tokens = nodes.map((node) => {
      const start = Number(node.getAttribute('start') || 0);
      const dur = Number(node.getAttribute('dur') || 2.5);
      return {
        start,
        end: start + Math.max(dur, 0.25),
        text: normalizeText(node.textContent || '')
      };
    }).filter((t) => t.text);
    return tokensToCues(tokens, payload);
  }

  function tokensToCues(tokens, payload) {
    const clean = tokens
      .filter((t) => t && t.text && Number.isFinite(t.start) && Number.isFinite(t.end))
      .sort((a, b) => a.start - b.start || a.end - b.end);

    if (!clean.length) return [];

    const allText = clean.map((t) => t.text).join(' ');
    const cjk = isCJK(allText);
    const sep = cjk ? '' : ' ';
    const maxLength = cjk ? 46 : 130;
    const terminal = cjk ? /[。！？.!?]$/ : /[.!?]$/;
    const comma = cjk ? /[、，,;:]$/ : /[,;:]$/;
    const hardGap = 1.35;
    const cuesOut = [];
    let current = [];

    function currentText(extra = null) {
      const arr = extra ? current.concat(extra) : current;
      return normalizeText(arr.map((x) => x.text).join(sep));
    }

    function buildTimingSegments(text, arr) {
      let cursor = 0;
      return arr.map((token) => {
        const tokenText = normalizeText(token.text);
        let startChar = text.indexOf(tokenText, cursor);
        if (startChar < 0) startChar = cursor;
        const endChar = Math.min(text.length, startChar + tokenText.length);
        cursor = Math.max(cursor, endChar);
        return {
          text: tokenText,
          start: token.start,
          end: token.end,
          startChar,
          endChar
        };
      }).filter((seg) => seg.text);
    }

    function emit(arr = current) {
      if (!arr.length) return;
      const text = normalizeText(arr.map((x) => x.text).join(sep));
      if (!text) return;
      const start = arr[0].start;
      const end = Math.max(arr[arr.length - 1].end, start + 0.25);
      cuesOut.push({ start, end, text, timingSegments: buildTimingSegments(text, arr) });
    }

    function splitAndEmitIfLong() {
      if (current.length <= 1 || currentText().length <= maxLength) return false;
      let best = -1;
      for (let i = 0; i < current.length - 1; i += 1) {
        if (comma.test(current[i].text)) best = i;
      }
      if (best < 0) best = Math.floor(current.length / 2) - 1;
      if (best < 0) return false;
      emit(current.slice(0, best + 1));
      current = current.slice(best + 1);
      return true;
    }

    for (const token of clean) {
      if (current.length) {
        const last = current[current.length - 1];
        const gap = token.start - last.end;
        const wouldBe = currentText(token);
        if (gap > hardGap) {
          emit();
          current = [];
        } else if (wouldBe.length > maxLength) {
          splitAndEmitIfLong();
          if (currentText(token).length > maxLength) {
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

    const videoId = payload.videoId || extractCurrentVideoId() || 'unknown-video';
    const lang = payload.tlang || payload.rawLang || 'unknown-lang';
    return cuesOut.map((cue, index) => {
      const id = `${videoId}:${lang}:${index}:${cue.start.toFixed(3)}:${hashString(cue.text)}`;
      return { id, index, ...cue, translated: '', pending: false };
    });
  }

  function parseTimedText(payload) {
    if (!payload || !payload.body) return [];
    const body = String(payload.body || '').trim();
    if (!body) return [];
    if (payload.format === 'json3' || body.startsWith('{') || body.startsWith('[')) return parseYouTubeJson3(body, payload);
    if (payload.format === 'xml' || body.startsWith('<')) return parseYouTubeXml(body, payload);
    throw new Error(`Unsupported timedtext format: ${payload.format}`);
  }


  function parseVttTimestamp(value) {
    const text = String(value || '').trim().replace(',', '.');
    const parts = text.split(':');
    if (parts.length < 2) return NaN;
    let seconds = 0;
    const last = Number(parts.pop());
    const minutes = Number(parts.pop());
    const hours = parts.length ? Number(parts.pop()) : 0;
    if (!Number.isFinite(last) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return NaN;
    seconds += last;
    seconds += minutes * 60;
    seconds += hours * 3600;
    return seconds;
  }

  function stripVttCueText(text) {
    return decodeHtmlEntities(String(text || '')
      .replace(/<\/?(?:c|v|lang|ruby|rt|b|i|u)[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' '));
  }

  function coerceTextBody(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      for (const key of ['body', 'text', 'content', 'data', 'response']) {
        if (typeof raw[key] === 'string') return raw[key];
      }
      try { return JSON.stringify(raw); } catch { return String(raw); }
    }
    return String(raw);
  }

  function looksLikeWebVtt(body = '', url = '', contentType = '') {
    const text = coerceTextBody(body).replace(/^\uFEFF/, '').trimStart();
    return /^WEBVTT(?:\s|$)/i.test(text) || /text\/vtt|webvtt/i.test(contentType || '') || /\.(?:vtt|webvtt)(?:$|[?#])/i.test(url || '');
  }

  function normalizeMaybeEscapedVttBody(raw) {
    let body = coerceTextBody(raw);
    if (!body) return '';
    body = body.replace(/^\uFEFF/, '');
    // Some bridge/debug paths can accidentally deliver a quoted/escaped VTT string.
    const trimmed = body.trim();
    if ((trimmed.startsWith('\"WEBVTT') || trimmed.startsWith("'WEBVTT")) && /\\n/.test(trimmed)) {
      try { body = JSON.parse(trimmed); } catch {}
    }
    if (/^WEBVTT\\[rn]/i.test(body) || /^WEBVTT.*\\n/i.test(body.slice(0, 120))) {
      body = body.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return body;
  }

  function extractVttBodyFromJsonLike(raw) {
    const text = coerceTextBody(raw).trim();
    if (!(text.startsWith('{') || text.startsWith('['))) return '';
    try {
      const json = JSON.parse(text);
      let found = '';
      const seen = new WeakSet();
      const walk = (value) => {
        if (found || value == null) return;
        if (typeof value === 'string') {
          const maybe = normalizeMaybeEscapedVttBody(value).trimStart();
          if (/^WEBVTT(?:\s|$)/i.test(maybe)) found = maybe;
          return;
        }
        if (typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          value.forEach(walk);
        } else {
          for (const key of ['body', 'text', 'content', 'vtt', 'data', 'response']) walk(value[key]);
          for (const child of Object.values(value)) walk(child);
        }
      };
      walk(json);
      return found;
    } catch {
      return '';
    }
  }

  function previewBodyForError(body) {
    return coerceTextBody(body).replace(/\s+/g, ' ').slice(0, 180);
  }

  function parseWebVtt(body, metadata = {}) {
    const lines = String(body || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
    const cuesOut = [];
    let i = 0;
    let index = 0;
    while (i < lines.length) {
      let line = lines[i].trim();
      if (!line || /^WEBVTT/i.test(line) || /^NOTE(?:\s|$)/i.test(line) || /^STYLE(?:\s|$)/i.test(line) || /^REGION(?:\s|$)/i.test(line)) {
        i += 1;
        if (/^NOTE/i.test(line)) while (i < lines.length && lines[i].trim()) i += 1;
        continue;
      }
      if (!line.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) {
        i += 1;
        line = lines[i].trim();
      }
      if (!line.includes('-->')) {
        i += 1;
        continue;
      }
      const [startPart, endPartRaw] = line.split('-->');
      const endPart = String(endPartRaw || '').trim().split(/\s+/)[0];
      const start = parseVttTimestamp(startPart);
      const end = parseVttTimestamp(endPart);
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i += 1;
      }
      const text = normalizeText(stripVttCueText(textLines.join('\n')));
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        const lang = metadata.language || metadata.rawLang || metadata.label || 'unknown-lang';
        const sourceId = metadata.videoId || extractCurrentVideoId() || 'udemy-video';
        const id = `${sourceId}:${lang}:vtt:${index}:${start.toFixed(3)}:${hashString(text)}`;
        cuesOut.push({
          id,
          index,
          start,
          end: Math.max(end, start + 0.25),
          rawStart: start,
          rawEnd: Math.max(end, start + 0.25),
          text,
          timingSegments: [],
          translated: '',
          pending: false
        });
        index += 1;
      }
      i += 1;
    }
    return cuesOut;
  }

  function cuesFromTextTrack(track) {
    const cueList = Array.from(track?.cues || track?.activeCues || []);
    const sourceId = extractCurrentVideoId() || 'udemy-video';
    const lang = track?.language || track?.label || 'texttrack';
    return cueList
      .map((cue, index) => {
        const start = Number(cue.startTime);
        const end = Number(cue.endTime);
        const text = normalizeText(stripVttCueText(cue.text || ''));
        if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return {
          id: `${sourceId}:${lang}:track:${index}:${start.toFixed(3)}:${hashString(text)}`,
          index,
          start,
          end,
          rawStart: start,
          rawEnd: end,
          text,
          timingSegments: [],
          translated: '',
          pending: false
        };
      })
      .filter(Boolean);
  }

  function languageLooksJapanese(value = '') {
    const text = String(value || '').toLowerCase();
    return /(^|[-_])ja($|[-_])|jpn|japanese|日本|日本語/.test(text);
  }

  function languageMatchesPreference(candidate, pref = 'auto') {
    const wanted = String(pref || 'auto').trim().toLowerCase();
    if (!wanted || wanted === 'auto') return true;
    const hay = `${candidate.language || ''} ${candidate.label || ''} ${candidate.url || ''}`.toLowerCase();
    if (wanted === 'japanese' || wanted === 'ja') return languageLooksJapanese(hay);
    return hay.includes(wanted);
  }

  function scoreUdemyCaptionCandidate(candidate) {
    let score = 0;
    const pref = settings.udemySourceLang || settings.sourceLang || 'auto';
    if (languageMatchesPreference(candidate, pref)) score += 50;
    if (languageLooksJapanese(`${candidate.language || ''} ${candidate.label || ''}`)) score += 25;
    if (/\.vtt(?:$|[?#])/i.test(candidate.url || '')) score += 12;
    if (candidate.body) score += 12;
    if (/lecture-api/i.test(candidate.source || '')) score += 30;
    if (/api-json|network-vtt|texttrack/i.test(candidate.source || '')) score += 6;
    return score;
  }

  function isBareUdemyCaptionFileName(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return false;
    // Udemy lecture JSON contains fields such as title/file_name
    // (for example introduction.autogenerated.vtt). Those are labels, not
    // fetchable URLs. Resolving them against the lecture page creates a bogus
    // URL like /learn/lecture/introduction.autogenerated.vtt that returns HTML.
    return /^[^/?#]+\.(?:vtt|webvtt)(?:[?#].*)?$/i.test(raw);
  }

  function isLikelyFetchableUdemyVttUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (isBareUdemyCaptionFileName(raw)) return false;
    try {
      const url = new URL(raw, location.href);
      if (!/^(https?:|blob:|data:)/i.test(url.protocol)) return false;
      if (!/\.(?:vtt|webvtt)(?:$|[?#])/i.test(url.href)) return false;
      // This is almost certainly a SPA route generated from a caption title or
      // file_name. It is not a real caption file.
      if (url.origin === location.origin && /\/learn\/lecture\/[^/?#]+\.(?:vtt|webvtt)(?:$|[?#])/i.test(url.pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function normalizeUdemyCandidate(candidate = {}) {
    const rawUrl = String(candidate.url || '').trim();
    try {
      let url = '';
      if (rawUrl) {
        if (candidate.body || isLikelyFetchableUdemyVttUrl(rawUrl)) {
          url = new URL(rawUrl, location.href).toString();
        } else {
          return {
            ...candidate,
            url: '',
            label: candidate.label || candidate.title || candidate.display_name || candidate.name || rawUrl || '',
            language: candidate.language || candidate.locale || candidate.locale_id || candidate.lang || candidate.srclang || '',
            source: candidate.source || 'unknown',
            invalidReason: `ignored non-fetchable VTT candidate: ${rawUrl}`
          };
        }
      }
      return {
        ...candidate,
        url,
        label: candidate.label || candidate.title || candidate.display_name || candidate.name || '',
        language: candidate.language || candidate.locale || candidate.locale_id || candidate.lang || candidate.srclang || '',
        source: candidate.source || 'unknown'
      };
    } catch {
      return { ...candidate, url: '', invalidReason: `invalid VTT URL: ${rawUrl}` };
    }
  }

  function rememberUdemyCandidates(candidates = []) {
    let added = 0;
    for (const raw of candidates) {
      const c = normalizeUdemyCandidate(raw);
      if (!c.url) continue;
      const key = c.url;
      if (!udemyCaptionCandidates.has(key)) added += 1;
      udemyCaptionCandidates.set(key, c);
    }
    if (added && settings.debug) log(`[Udemy] caption candidates +${added}`, Array.from(udemyCaptionCandidates.values()).slice(0, 6));
    return added;
  }

  function chooseUdemyCaptionCandidate() {
    const candidates = Array.from(udemyCaptionCandidates.values()).filter((c) => languageMatchesPreference(c, settings.udemySourceLang || 'auto'));
    const pool = candidates.length ? candidates : Array.from(udemyCaptionCandidates.values());
    return pool.sort((a, b) => scoreUdemyCaptionCandidate(b) - scoreUdemyCaptionCandidate(a))[0] || null;
  }

  async function loadUdemyCaptionCandidate(candidate, bodyOverride = '') {
    if (!candidate || !settings.enableUdemy || udemyCaptionLoadInFlight) return;
    if (/(?:thumb|sprite)/i.test(`${candidate.url || ''} ${candidate.label || ''} ${candidate.fileName || ''}`)) return;
    const key = `${candidate.url || 'body'}:${candidate.language || ''}:${candidate.label || ''}`;
    if (currentTrackKey === key && cues.length) return;
    udemyCaptionLoadInFlight = true;
    try {
      let body = coerceTextBody(bodyOverride || candidate.body || '');
      let contentType = candidate.contentType || '';
      let finalUrl = candidate.url || '';

      if (!body && candidate.url) {
        try {
          const page = await fetchTextInUdemyPage(candidate.url, { headers: { accept: 'text/vtt, text/plain, application/json, */*' }, timeoutMs: 10000 });
          body = coerceTextBody(page.body || '');
          contentType = page.contentType || contentType;
          finalUrl = page.url || finalUrl;
        } catch (pageFetchErr) {
          try {
            const res = await fetch(candidate.url, { credentials: getFetchCredentialsForUrl(candidate.url, 'include'), headers: { accept: 'text/vtt, text/plain, application/json, */*' } });
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
            body = text;
            contentType = res.headers?.get?.('content-type') || contentType;
            finalUrl = res.url || finalUrl;
          } catch (fetchErr) {
            const bg = await sendMessage({ type: 'FETCH_TEXT', payload: { url: candidate.url } });
            if (!bg?.ok) throw new Error(bg?.error || describeError(fetchErr) || describeError(pageFetchErr) || 'Failed to fetch Udemy captions');
            body = coerceTextBody(bg.body || '');
            contentType = bg.contentType || contentType;
            finalUrl = bg.url || finalUrl;
          }
        }
      }

      // If a bridge accidentally routed lecture JSON here, extract its captions instead
      // of trying to parse the JSON response as WebVTT.
      const trimmed = body.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const embeddedVtt = extractVttBodyFromJsonLike(body);
        if (embeddedVtt) {
          body = embeddedVtt;
        } else {
          try {
            const json = JSON.parse(body);
            const candidates = captionCandidatesFromUdemyLectureJson(json, {
              courseId: candidate.courseId || '',
              lectureId: candidate.lectureId || extractUdemyLectureId()
            });
            if (candidates.length) {
              rememberUdemyCandidates(candidates);
              const best = chooseUdemyCaptionCandidate();
              if (best && best.url !== candidate.url) {
                udemyCaptionLoadInFlight = false;
                await loadUdemyCaptionCandidate(best);
                return;
              }
            }
          } catch {}
          throw new Error(`Expected WebVTT but got JSON/API response. url=${finalUrl || candidate.url || 'body'} preview=${previewBodyForError(body)}`);
        }
      }

      body = normalizeMaybeEscapedVttBody(body);
      if (!looksLikeWebVtt(body, finalUrl || candidate.url || '', contentType)) {
        throw new Error(`Expected WebVTT but got non-VTT response. url=${finalUrl || candidate.url || 'body'} contentType=${contentType || 'unknown'} preview=${previewBodyForError(body)}`);
      }

      const parsed = normalizeCueDisplayTiming(parseWebVtt(body, {
        ...candidate,
        videoId: extractCurrentVideoId(),
        rawLang: candidate.language || candidate.label || 'auto'
      }));
      if (!parsed.length) throw new Error(`No VTT cues parsed. url=${finalUrl || candidate.url || 'body'} preview=${previewBodyForError(body)}`);
      setSubtitleCuesFromPlatform(parsed, {
        platform: 'udemy',
        trackKey: key,
        sourceLang: candidate.language || candidate.label || settings.udemySourceLang || 'auto',
        status: `Loaded ${parsed.length} Udemy subtitle cues${candidate.label ? ` (${candidate.label})` : ''}.`
      });
    } catch (err) {
      if (settings.debug) console.warn('[Video-Translator] Failed to load Udemy captions:', err, candidate);
      if (!cues.length) statusMessage = `Udemy captions found but could not be loaded: ${err?.message || err}`;
    } finally {
      udemyCaptionLoadInFlight = false;
    }
  }

  function setSubtitleCuesFromPlatform(parsed, meta = {}) {
    if (!parsed.length) return;
    const signature = hashString(parsed.map((cue) => `${cue.rawStart ?? cue.start}:${cue.rawEnd ?? cue.end}:${cue.displayEnd ?? cue.end}:${cue.text}`).join('|'));
    if (signature === lastTimedTextHash && currentTrackKey === meta.trackKey) return;
    lastTimedTextHash = signature;
    currentTrackKey = meta.trackKey || `${meta.platform || getPlatformId()}:${signature}`;
    currentSourceLang = meta.sourceLang || settings.sourceLang || 'auto';
    const previousTranslations = cueMap;
    cues = parsed.map((cue, index) => {
      cue.index = index;
      const prior = previousTranslations.get(cue.id);
      if (prior?.translated) cue.translated = prior.translated;
      return cue;
    });
    cueMap = new Map(cues.map((cue) => [cue.id, cue]));
    buildCueIndex();
    pendingIds.clear();
    clearCueRenderState();
    statusMessage = meta.status || `Loaded ${cues.length} subtitle cues (${currentSourceLang}).`;
    log(statusMessage, cues.slice(0, 3));
    renderNow(true);
    scheduleAhead(true);
  }

  async function handleUdemyCaptionFile(payload = {}) {
    if (!isUdemyPlatform() || !settings.enableUdemy) return;
    const candidate = normalizeUdemyCandidate({ ...payload, source: payload.source || 'network-vtt' });
    if (candidate.url) rememberUdemyCandidates([candidate]);
    await loadUdemyCaptionCandidate(candidate, payload.body || '');
  }

  async function handleUdemyCaptionCandidates(payload = {}) {
    if (!isUdemyPlatform() || !settings.enableUdemy) return;
    const added = rememberUdemyCandidates(payload.candidates || []);
    if (!added && cues.length) return;
    const best = chooseUdemyCaptionCandidate();
    if (best) await loadUdemyCaptionCandidate(best);
  }


  function buildUdemyLectureApiUrl(courseId, lectureId) {
    const url = new URL(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/`, location.origin);
    url.searchParams.set('fields[lecture]', 'asset,description,download_url,is_free,last_watched_second');
    url.searchParams.set('fields[asset]', 'asset_type,length,media_license_token,course_is_drmed,media_sources,captions,thumbnail_sprite,slides,slide_urls,download_urls,external_url');
    // Udemy app adds a cache-buster. Keep one so expired signed caption URLs
    // are refreshed when the lecture API is reloaded.
    url.searchParams.set('q', String(Math.random()));
    return url.toString();
  }

  function captionCandidatesFromUdemyLectureJson(json, context = {}) {
    const asset = json?.asset || json?.lecture?.asset || json?.data?.asset || null;
    const captions = Array.isArray(asset?.captions) ? asset.captions : [];
    return captions
      .map((caption) => normalizeUdemyCandidate({
        url: caption.url || caption.src || caption.href || '',
        label: caption.video_label || caption.label || caption.title || caption.file_name || caption.locale_id || '',
        language: caption.locale_id || caption.language || caption.locale || caption.lang || '',
        kind: caption.source || caption.status || '',
        source: 'lecture-api',
        lectureId: context.lectureId || json?.id || '',
        courseId: context.courseId || '',
        assetId: asset?.id || caption.asset_id || '',
        captionId: caption.id || '',
        fileName: caption.file_name || ''
      }))
      .filter((candidate) => candidate.url);
  }

  async function fetchUdemyLectureApiJson(courseId, lectureId) {
    const apiUrl = buildUdemyLectureApiUrl(courseId, lectureId);
    const headers = buildUdemyApiHeaders();

    try {
      const page = await fetchTextInUdemyPage(apiUrl, { headers, timeoutMs: 9000 });
      return { json: JSON.parse(page.body || '{}'), apiUrl: page.url || apiUrl };
    } catch (pageFetchErr) {
      try {
        const res = await fetch(apiUrl, { credentials: 'include', headers });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        return { json: JSON.parse(text), apiUrl };
      } catch (fetchErr) {
        // Background fallback covers edge cases where content-script fetch is blocked.
        const bg = await sendMessage({ type: 'FETCH_TEXT', payload: { url: apiUrl } });
        if (!bg?.ok) {
          throw new Error(bg?.error || describeError(fetchErr) || describeError(pageFetchErr) || 'Failed to fetch Udemy lecture API');
        }
        return { json: JSON.parse(bg.body || '{}'), apiUrl: bg.url || apiUrl };
      }
    }
  }

  async function discoverUdemyLectureApiCaptions(force = false) {
    if (!isUdemyPlatform() || !settings.enableUdemy) return false;
    const lectureId = extractUdemyLectureId();
    const courseCandidates = getUdemyNumericCourseCandidates();
    if (!lectureId || !courseCandidates.length) {
      if (settings.debug) log('[Udemy] lecture API skipped: missing ids', { lectureId, courseCandidates });
      return false;
    }

    const primaryCourseId = courseCandidates[0].id;
    const attemptKey = `${primaryCourseId}:${lectureId}:${settings.udemySourceLang || 'auto'}`;
    const now = Date.now();
    if (!force && lastUdemyLectureApiKey === attemptKey && (udemyLectureApiInFlight || now - lastUdemyLectureApiAttemptAt < 8000)) return Boolean(cues.length);
    if (udemyLectureApiInFlight) return false;

    udemyLectureApiInFlight = true;
    lastUdemyLectureApiAttemptAt = now;
    lastUdemyLectureApiKey = attemptKey;

    try {
      let lastError = null;
      for (const { id: courseId, source } of courseCandidates.slice(0, 6)) {
        try {
          const { json, apiUrl } = await fetchUdemyLectureApiJson(courseId, lectureId);
          const candidates = captionCandidatesFromUdemyLectureJson(json, { courseId, lectureId, apiUrl });
          if (settings.debug) log(`[Udemy] lecture API ${courseId}/${lectureId} via ${source || 'unknown'}: ${candidates.length} caption(s)`, candidates);
          if (!candidates.length) continue;
          rememberUdemyCandidates(candidates);
          const best = chooseUdemyCaptionCandidate();
          if (best) {
            await loadUdemyCaptionCandidate({ ...best, source: best.source || 'lecture-api' });
            return Boolean(cues.length);
          }
        } catch (err) {
          lastError = err;
          const msg = describeError(err);
          if (settings.debug) console.warn(`[Video-Translator] Udemy lecture API candidate failed: courseId=${courseId} lectureId=${lectureId} source=${source || 'unknown'} error=${msg}`);
        }
      }
      if (!cues.length && lastError) statusMessage = `Udemy lecture API captions not loaded: ${lastError?.message || lastError}`;
      return false;
    } finally {
      udemyLectureApiInFlight = false;
    }
  }

  async function discoverUdemyPerformanceVtt() {
    if (!isUdemyPlatform() || !settings.enableUdemy) return false;
    let candidates = [];
    try {
      const entries = performance.getEntriesByType?.('resource') || [];
      candidates = entries
        .map((entry) => String(entry.name || ''))
        .filter((url) => /\.(?:vtt|webvtt)(?:$|[?#])/i.test(url) && !/(?:thumb|sprite)/i.test(url) && /(?:caption|subtitle|transcript|vtt-c\.udemycdn)/i.test(url))
        .map((url) => normalizeUdemyCandidate({ url, label: 'Udemy VTT', language: '', source: 'performance-vtt' }))
        .filter((candidate) => candidate.url);
    } catch {}
    if (!candidates.length) return false;
    rememberUdemyCandidates(candidates);
    const best = chooseUdemyCaptionCandidate();
    if (best) {
      if (settings.debug) log('[Udemy] loading VTT from performance resource', best);
      await loadUdemyCaptionCandidate(best);
      return Boolean(cues.length);
    }
    return false;
  }

  async function discoverUdemyTextTracks() {
    if (!isUdemyPlatform() || !settings.enableUdemy) return false;
    const v = findVideo();
    if (!v || !v.textTracks || !v.textTracks.length) return false;
    const tracks = Array.from(v.textTracks || []);
    let bestTrack = null;
    let bestScore = -1;
    for (const track of tracks) {
      try {
        if (track.mode === 'disabled') track.mode = 'hidden';
      } catch {}
      const candidate = { language: track.language || '', label: track.label || '', source: 'texttrack' };
      if (!languageMatchesPreference(candidate, settings.udemySourceLang || 'auto')) continue;
      const cueCount = track.cues?.length || 0;
      const score = scoreUdemyCaptionCandidate(candidate) + Math.min(30, cueCount);
      if (cueCount > 0 && score > bestScore) {
        bestScore = score;
        bestTrack = track;
      }
    }
    if (!bestTrack) return false;
    const parsed = normalizeCueDisplayTiming(cuesFromTextTrack(bestTrack));
    if (!parsed.length) return false;
    const signature = hashString(parsed.map((cue) => `${cue.start}:${cue.end}:${cue.text}`).join('|'));
    if (signature === lastUdemyTextTrackSignature && cues.length) return true;
    lastUdemyTextTrackSignature = signature;
    setSubtitleCuesFromPlatform(parsed, {
      platform: 'udemy',
      trackKey: `udemy:texttrack:${bestTrack.language || bestTrack.label || ''}:${signature}`,
      sourceLang: bestTrack.language || bestTrack.label || settings.udemySourceLang || 'auto',
      status: `Loaded ${parsed.length} Udemy textTrack cues${bestTrack.label ? ` (${bestTrack.label})` : ''}.`
    });
    return true;
  }

  async function discoverUdemyTrackElements() {
    if (!isUdemyPlatform() || !settings.enableUdemy) return false;
    const tracks = Array.from(document.querySelectorAll('track[kind="subtitles"], track[kind="captions"], track[src]'));
    const candidates = tracks
      .map((track) => normalizeUdemyCandidate({
        url: track.getAttribute('src') || '',
        label: track.getAttribute('label') || '',
        language: track.getAttribute('srclang') || track.getAttribute('lang') || '',
        source: 'track-element'
      }))
      .filter((c) => c.url);
    if (!candidates.length) return false;
    rememberUdemyCandidates(candidates);
    const best = chooseUdemyCaptionCandidate();
    if (best) {
      await loadUdemyCaptionCandidate(best);
      return true;
    }
    return false;
  }

  async function discoverUdemyCaptions(force = false) {
    if (!isUdemyPlatform() || !settings.enableUdemy) return;
    const now = Date.now();
    if (!force && now - lastUdemyCaptionDiscoveryAt < 1800) return;
    lastUdemyCaptionDiscoveryAt = now;
    if (await discoverUdemyLectureApiCaptions(force)) return;
    if (await discoverUdemyPerformanceVtt()) return;
    if (await discoverUdemyTextTracks()) return;
    if (await discoverUdemyTrackElements()) return;
    const best = chooseUdemyCaptionCandidate();
    if (best && !cues.length) await loadUdemyCaptionCandidate(best);
    if (!cues.length && !best) statusMessage = 'No Udemy captions found yet. Try turning on captions in the Udemy player.';
  }

  function normalizeCueDisplayTiming(inputCues) {
    // Keep raw YouTube timing, but derive separate display/progress timing.
    // displayEnd controls how long the subtitle remains visible; progressEnd
    // controls the fallback karaoke sweep. Segment-based karaoke still uses
    // YouTube segment timestamps when they pass reliability checks.
    const HOLD_GAP_SECONDS = 2.25;
    const MIN_DISPLAY_SECONDS = 0.85;
    const sorted = inputCues
      .map((cue) => {
        const rawStart = Number(cue.rawStart ?? cue.start ?? 0);
        const rawEnd = Math.max(Number(cue.rawEnd ?? cue.end ?? rawStart + 0.25), rawStart + 0.25);
        return {
          ...cue,
          rawStart,
          rawEnd,
          displayStart: rawStart,
          displayEnd: rawEnd,
          progressStart: rawStart,
          progressEnd: rawEnd,
          start: rawStart,
          end: rawEnd
        };
      })
      .sort((a, b) => getCueRawStart(a) - getCueRawStart(b) || getCueRawEnd(a) - getCueRawEnd(b));

    for (let i = 0; i < sorted.length; i += 1) {
      const cue = sorted[i];
      const next = sorted[i + 1];
      const rawStart = getCueRawStart(cue);
      const rawEnd = getCueRawEnd(cue);
      const rawDuration = rawEnd - rawStart;
      const textWeight = getTimingTextWeight(cue.text);
      const nextRawStart = next ? getCueRawStart(next) : Infinity;
      const maxEndBeforeNext = Number.isFinite(nextRawStart) && nextRawStart > rawStart
        ? Math.max(rawStart + 0.25, nextRawStart - 0.03)
        : Infinity;

      const minDisplayDuration = Math.min(2.8, Math.max(MIN_DISPLAY_SECONDS, textWeight * 0.045));
      let displayEnd = Math.max(rawEnd, rawStart + minDisplayDuration);

      if (next) {
        const gap = nextRawStart - rawEnd;
        if (gap > 0 && gap <= HOLD_GAP_SECONDS) {
          displayEnd = Math.max(displayEnd, maxEndBeforeNext);
        } else if (rawEnd > nextRawStart && nextRawStart > rawStart) {
          displayEnd = maxEndBeforeNext;
        }
        displayEnd = Math.min(displayEnd, maxEndBeforeNext);
      }
      displayEnd = Math.max(rawStart + 0.25, displayEnd);

      const minProgressDuration = Math.min(2.8, Math.max(0.85, textWeight * 0.08));
      let progressEnd = rawEnd;
      if (rawDuration < minProgressDuration) {
        progressEnd = rawStart + minProgressDuration;
      } else {
        const estimatedSpeakingDuration = clamp(textWeight * 0.12, 0.9, rawDuration);
        if (rawDuration > estimatedSpeakingDuration * 1.65 && textWeight <= 32) {
          progressEnd = rawStart + estimatedSpeakingDuration;
        }
      }
      progressEnd = Math.min(progressEnd, displayEnd, maxEndBeforeNext);
      progressEnd = Math.max(rawStart + 0.25, progressEnd);

      cue.displayStart = rawStart;
      cue.displayEnd = displayEnd;
      cue.progressStart = rawStart;
      cue.progressEnd = progressEnd;
      // Keep the existing fields display-oriented for old code paths.
      cue.start = cue.displayStart;
      cue.end = cue.displayEnd;

      if (settings.debug) {
        const source = isReliableSegmentTiming(cue) ? 'segment' : 'linear';
        log(`[Timing] source=${source} segs=${Array.isArray(cue.timingSegments) ? cue.timingSegments.length : 0} raw=${rawDuration.toFixed(2)} display=${(cue.displayEnd - cue.displayStart).toFixed(2)} progress=${(cue.progressEnd - cue.progressStart).toFixed(2)}`, cue.text);
      }
    }
    return sorted;
  }

  async function maybeFetchOriginalTrack(payload) {
    if (!payload?.tlang || !payload?.url) return null;
    try {
      const u = new URL(payload.url, location.href);
      u.searchParams.delete('tlang');
      const key = u.toString();
      if (fetchedOriginalUrls.has(key)) return null;
      fetchedOriginalUrls.add(key);
      const res = await fetch(key, { credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.text();
      return {
        ...payload,
        url: key,
        tlang: null,
        format: body.trim().startsWith('<') ? 'xml' : 'json3',
        body
      };
    } catch (err) {
      log('Failed to fetch original timedtext track:', err);
      return null;
    }
  }

  async function handleTimedTextPayload(payload) {
    const newVideoId = payload.videoId || extractCurrentVideoId();
    if (newVideoId && currentVideoId && newVideoId !== currentVideoId) resetForVideo(newVideoId);
    if (newVideoId && !currentVideoId) currentVideoId = newVideoId;

    if (payload.tlang) {
      const original = await maybeFetchOriginalTrack(payload);
      if (original) payload = original;
    }

    let parsed;
    try {
      parsed = normalizeCueDisplayTiming(parseTimedText(payload));
    } catch (err) {
      console.warn('[Video-Translator] Failed to parse timedtext:', err);
      return;
    }
    if (!parsed.length) return;

    const signature = hashString(parsed.map((cue) => `${cue.rawStart ?? cue.start}:${cue.rawEnd ?? cue.end}:${cue.displayEnd ?? cue.end}:${cue.text}`).join('|'));
    if (signature === lastTimedTextHash && currentTrackKey === `${payload.videoId}:${payload.rawLang}:${payload.tlang || ''}:${payload.kind || ''}`) return;

    lastTimedTextHash = signature;
    currentTrackKey = `${payload.videoId}:${payload.rawLang}:${payload.tlang || ''}:${payload.kind || ''}`;
    currentSourceLang = payload.rawLang || payload.tlang || settings.sourceLang || 'auto';

    const previousTranslations = cueMap;
    cues = parsed.map((cue) => {
      const prior = previousTranslations.get(cue.id);
      if (prior?.translated) cue.translated = prior.translated;
      return cue;
    });
    cueMap = new Map(cues.map((cue) => [cue.id, cue]));
    buildCueIndex();
    pendingIds.clear();
    lastVisibleCue = null;
    lastVisibleCueWallTime = 0;
    activeCueId = null;
    activeTranslated = null;
    activeStudyProgressKey = null;
    statusMessage = `Loaded ${cues.length} subtitle cues (${currentSourceLang}).`;
    log(statusMessage, cues.slice(0, 3));
    renderNow(true);
    scheduleAhead(true);
  }

  function resetForVideo(videoId = '') {
    currentVideoId = videoId;
    currentTrackKey = '';
    currentSourceLang = 'auto';
    cues = [];
    cueMap = new Map();
    buildCueIndex();
    pendingIds.clear();
    lastVisibleCue = null;
    lastVisibleCueWallTime = 0;
    lastStablePlaybackTime = 0;
    lastStablePlaybackWallTime = 0;
    if (isUdemyPlatform()) resetUdemyRenderState();
    pendingUrgentTranslation = false;
    activeCueId = null;
    activeTranslated = null;
    activeStudyProgressKey = null;
    translateInFlight = false;
    lastTimedTextHash = '';
    fetchedOriginalUrls.clear();
    udemyCaptionCandidates.clear();
    udemyLectureApiInFlight = false;
    lastUdemyCaptionDiscoveryAt = 0;
    lastUdemyLectureApiAttemptAt = 0;
    lastUdemyLectureApiKey = '';
    lastUdemyTextTrackSignature = '';
    statusMessage = getDefaultStatusMessage();
    loadLayoutForCurrentVideo().then(() => {
      applyLayoutRegions();
      updateLayoutStyles();
    });
    renderNow(true);
  }

  function isElementVisibleEnough(el, minWidth = 48, minHeight = 36) {
    if (!el || !el.isConnected) return false;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { return false; }
    if (!rect || rect.width < minWidth || rect.height < minHeight) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0.02) return false;
    } catch {}
    return true;
  }

  function collectVideosInOpenShadow(root, out = [], depth = 0) {
    if (!root || depth > 4) return out;
    try {
      root.querySelectorAll?.('video')?.forEach((v) => out.push(v));
    } catch {}

    // Some Udemy/player builds put the actual playable video in an open shadow
    // root, and some pages also keep hidden <video> elements around. Collect all
    // candidates first, then choose the visible/largest one instead of blindly
    // taking document.querySelector('video').
    let scanned = 0;
    try {
      const walkerRoot = root instanceof Document ? root.body || root.documentElement : root;
      if (!walkerRoot) return out;
      const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node && scanned < 3500) {
        scanned += 1;
        if (node.shadowRoot) collectVideosInOpenShadow(node.shadowRoot, out, depth + 1);
        node = walker.nextNode();
      }
    } catch {}
    return out;
  }

  function scoreVideoCandidate(v) {
    if (!v || !v.isConnected) return -Infinity;
    let rect;
    try { rect = v.getBoundingClientRect(); } catch { return -Infinity; }
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area <= 0) return -Infinity;
    let score = area;
    if (isElementVisibleEnough(v, 160, 90)) score += 10_000_000;
    if (Number.isFinite(v.duration) && v.duration > 0) score += 2_000_000;
    if (v.readyState > 0) score += 500_000;
    if (!v.paused) score += 1_000_000;
    if (v.currentSrc || v.src) score += 250_000;
    // Penalize tiny/hidden/preload videos that Udemy can keep in the DOM.
    if (rect.width < 160 || rect.height < 90) score -= 5_000_000;
    try {
      const cs = getComputedStyle(v);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || 1) <= 0.02) score -= 8_000_000;
    } catch {}
    return score;
  }

  function findBestVideoCandidate() {
    const candidates = Array.from(new Set(collectVideosInOpenShadow(document)));
    if (!candidates.length) return null;
    candidates.sort((a, b) => scoreVideoCandidate(b) - scoreVideoCandidate(a));
    return candidates[0] || null;
  }

  function isLockedUdemyVideoUsable(v, lectureKey) {
    if (!v || !v.isConnected || udemyRenderState.lockedLectureKey !== lectureKey) return false;
    const now = performance.now();
    const score = scoreVideoCandidate(v);
    const visible = score > 0 && isElementVisibleEnough(v, 160, 90);
    if (visible) {
      udemyRenderState.lockedBadSince = 0;
      return true;
    }

    if (!udemyRenderState.lockedBadSince) udemyRenderState.lockedBadSince = now;
    const graceMs = v.readyState > 0 ? 1100 : 650;
    if (score > 0 && now - udemyRenderState.lockedBadSince <= graceMs) {
      logUdemyRenderState('hold-locked-video', { ageMs: Math.round(now - udemyRenderState.lockedBadSince), score: Math.round(score) }, 1200);
      return true;
    }
    return false;
  }

  function findVideo() {
    if (isUdemyPlatform()) {
      const lectureKey = extractCurrentUdemyLectureKey();
      if (isLockedUdemyVideoUsable(udemyRenderState.lockedVideo, lectureKey)) {
        video = udemyRenderState.lockedVideo;
        return video;
      }

      if (udemyRenderState.lockedVideo && settings.debug) {
        logUdemyRenderState('unlock-video', {
          lectureKey,
          lockedLectureKey: udemyRenderState.lockedLectureKey,
          connected: Boolean(udemyRenderState.lockedVideo?.isConnected),
          badForMs: udemyRenderState.lockedBadSince ? Math.round(performance.now() - udemyRenderState.lockedBadSince) : 0
        }, 300);
      }

      const best = findBestVideoCandidate();
      if (!best) {
        video = null;
        udemyRenderState.lockedVideo = null;
        return null;
      }

      const signature = getVideoSignature(best);
      const changed = best !== udemyRenderState.lockedVideo || lectureKey !== udemyRenderState.lockedLectureKey || signature !== udemyRenderState.lockedVideoSignature;
      if (changed && settings.debug) {
        try {
          const r = best.getBoundingClientRect();
          logUdemyRenderState('lock-video', {
            currentTime: Number(best.currentTime || 0).toFixed(2),
            duration: Number.isFinite(best.duration) ? Number(best.duration).toFixed(2) : null,
            readyState: best.readyState,
            width: Math.round(r.width),
            height: Math.round(r.height),
            src: best.currentSrc || best.src || ''
          }, 300);
        } catch {}
      }
      udemyRenderState.lockedVideo = best;
      udemyRenderState.lockedLectureKey = lectureKey;
      udemyRenderState.lockedVideoSignature = signature;
      udemyRenderState.lockedBadSince = 0;
      video = best;
      return video;
    }

    const currentScore = scoreVideoCandidate(video);
    if (video && currentScore > 0 && isElementVisibleEnough(video, 160, 90)) return video;

    const best = findBestVideoCandidate();
    if (!best) {
      video = null;
      return null;
    }
    if (best && best !== video && settings.debug) {
      try {
        const r = best.getBoundingClientRect();
        log('[Video] selected video', { currentTime: best.currentTime, duration: best.duration, readyState: best.readyState, width: Math.round(r.width), height: Math.round(r.height), src: best.currentSrc || best.src || '' });
      } catch {}
    }
    video = best;
    return video;
  }

  function getCurrentTime() {
    const v = findVideo();
    if (!v) return lastStablePlaybackTime || 0;
    const t = Number(v.currentTime || 0);
    if (!Number.isFinite(t)) return lastStablePlaybackTime || 0;

    // Udemy can briefly expose/switch to a stale hidden video element while the
    // visible HLS player is still playing. That makes currentTime jump to 0 for
    // a frame and the overlay disappears. Ignore that transient backwards jump
    // unless the user is actually seeking.
    if (
      isUdemyPlatform() &&
      !seekingInProgress &&
      !v.seeking &&
      !v.paused &&
      lastStablePlaybackTime > 1.5 &&
      t + 1.25 < lastStablePlaybackTime &&
      performance.now() - lastStablePlaybackWallTime < 1400
    ) {
      return lastStablePlaybackTime;
    }

    lastStablePlaybackTime = t;
    lastStablePlaybackWallTime = performance.now();
    if (isUdemyPlatform()) {
      udemyRenderState.lastGoodVideoTime = t;
      const r = safeVideoRect(v);
      if (r && r.width > 0 && r.height > 0) udemyRenderState.lastGoodVideoRect = r;
    }
    return t;
  }

  function buildCueIndex() {
    cueDisplayStarts = cues.map((cue) => getCueDisplayStart(cue));
  }

  function findActiveCue(time) {
    if (!cues.length) return null;
    const t = Number(time) || 0;
    const target = t + 0.06;
    let lo = 0;
    let hi = cueDisplayStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cueDisplayStarts[mid] <= target) lo = mid + 1;
      else hi = mid;
    }

    // Cues are sorted. Scan backwards from the latest cue whose displayStart has
    // passed so overlapping/touching cues resolve to the later cue, like YouTube.
    const startIndex = Math.min(cues.length - 1, lo - 1);
    for (let i = startIndex; i >= 0; i -= 1) {
      const cue = cues[i];
      const displayStart = getCueDisplayStart(cue);
      const displayEnd = getCueDisplayEnd(cue);
      if (displayEnd < t - 0.35) break;
      if (t >= displayStart - 0.06 && t <= displayEnd + 0.12) return cue;
    }
    return null;
  }

  function findStableActiveCue(time) {
    const cue = findActiveCue(time);
    const now = performance.now();
    if (cue) {
      lastVisibleCue = cue;
      lastVisibleCueWallTime = now;
      if (isUdemyPlatform()) {
        udemyRenderState.lastRenderableCue = cue;
        udemyRenderState.lastRenderableAt = now;
      }
      return cue;
    }

    if (isUdemyPlatform() && !seekingInProgress && lastVisibleCue) {
      const v = findVideo();
      const t = Number(time) || 0;
      const displayStart = getCueDisplayStart(lastVisibleCue);
      const displayEnd = getCueDisplayEnd(lastVisibleCue);
      const wallAge = now - lastVisibleCueWallTime;
      const videoIsPlaying = Boolean(v && !v.paused && !v.ended && !v.seeking);
      const nearCue = t >= displayStart - 0.25 && t <= displayEnd + 1.2;
      const shortRenderGap = wallAge <= 900;
      const frameGlitch = wallAge <= 700 && Math.abs(t - (udemyRenderState.lastGoodVideoTime || t)) <= 1.35;
      if ((videoIsPlaying && nearCue && shortRenderGap) || frameGlitch) {
        logUdemyRenderState('hold-last-cue', {
          cueId: lastVisibleCue.id,
          t: Number(t).toFixed(2),
          displayEnd: Number(displayEnd).toFixed(2),
          wallAgeMs: Math.round(wallAge),
          reason: frameGlitch ? 'frame-glitch' : 'short-gap'
        }, 650);
        return lastVisibleCue;
      }
    }

    if (isUdemyPlatform()) {
      const t = Number(time) || 0;
      let reason = 'no-cue';
      const v = video || udemyRenderState.lockedVideo;
      if (!cues.length) reason = 'no-cues-loaded';
      else if (!v || !v.isConnected) reason = 'no-video';
      else if (seekingInProgress || v.seeking) reason = 'seeking';
      else if (lastVisibleCue) reason = 'outside-hold-window';
      logUdemyRenderState('hide-reason', {
        reason,
        t: Number(t).toFixed(2),
        cues: cues.length,
        lastCueId: lastVisibleCue?.id || '',
        lastCueEnd: lastVisibleCue ? Number(getCueDisplayEnd(lastVisibleCue)).toFixed(2) : null
      }, 900);
    }
    return null;
  }

  function getElementArea(el) {
    try {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      return 0;
    }
  }

  function getUdemyPlayerMountForVideo(v) {
    if (!v) return null;
    let vRect;
    try { vRect = v.getBoundingClientRect(); } catch { return v.parentElement || null; }
    const vArea = Math.max(1, vRect.width * vRect.height);
    const candidates = [];
    const add = (el, source = '') => {
      if (!el || candidates.some((item) => item.el === el)) return;
      if (!isElementVisibleEnough(el, Math.max(120, vRect.width * 0.45), Math.max(80, vRect.height * 0.45))) return;
      let r;
      try { r = el.getBoundingClientRect(); } catch { return; }
      if (r.width < vRect.width * 0.75 || r.height < vRect.height * 0.75) return;
      // The course page itself is a bad mount target because absolute positioning
      // then uses a huge area and subtitles appear far from the video. Prefer the
      // smallest visible ancestor that still covers the video.
      const areaRatio = Math.max(1, (r.width * r.height) / vArea);
      const edgePenalty = (Math.abs(r.left - vRect.left) + Math.abs(r.top - vRect.top)) / 120;
      const tooHugePenalty = areaRatio > 8 ? areaRatio * 10 : 0;
      candidates.push({ el, score: areaRatio + edgePenalty + tooHugePenalty, source });
    };

    const selector = '[data-purpose="video-player"], [data-purpose="asset--video-player"], [class*="video-player"], [class*="video-viewer"], [class*="video-player--container"], [class*="asset-viewer"], [class*="course-player"]';
    try { add(v.closest(selector), 'closest-selector'); } catch {}
    let node = v.parentElement;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 10) {
      add(node, `ancestor-${depth}`);
      node = node.parentElement;
      depth += 1;
    }
    try {
      document.querySelectorAll('[data-purpose="video-player"], [data-purpose="asset--video-player"], [class*="video-player"], [class*="video-viewer"], [class*="video-player--container"]').forEach((el) => add(el, 'query'));
    } catch {}
    candidates.sort((a, b) => a.score - b.score);
    if (settings.debug && candidates[0]) {
      try {
        const r = candidates[0].el.getBoundingClientRect();
        log('[Udemy] selected player mount', { source: candidates[0].source, width: Math.round(r.width), height: Math.round(r.height), score: Number(candidates[0].score.toFixed(2)) });
      } catch {}
    }
    return candidates[0]?.el || v.parentElement || null;
  }

  function findPlayerMount() {
    if (isUdemyPlatform()) {
      const v = findVideo();
      const mount = getUdemyPlayerMountForVideo(v);
      // On Udemy, content scripts run in all frames. If this particular frame has
      // no player, do not mount a duplicate overlay on <body>; wait for the video
      // frame instead.
      return mount || null;
    }
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function useFixedUdemyOverlay() {
    return isUdemyPlatform();
  }

  function getLayoutReferenceRect() {
    // Udemy can wrap the actual <video> in several stacking/overflow containers.
    // Use the visible video rectangle as the coordinate system and render fixed
    // overlays in the viewport so subtitles cannot end up behind Udemy's player
    // layers or in an over-wide course-page container.
    if (useFixedUdemyOverlay()) {
      const v = findVideo();
      const vr = v?.getBoundingClientRect?.();
      if (vr && vr.width > 80 && vr.height > 45) return vr;
    }
    const player = findPlayerMount();
    return player?.getBoundingClientRect?.() || null;
  }

  function applyFixedRegionFromRect(el, region, rect) {
    if (!el || !rect) return false;
    const r = clampRegion(region);
    el.style.position = 'fixed';
    el.style.left = `${Math.round(rect.left + rect.width * r.leftPct / 100)}px`;
    el.style.top = `${Math.round(rect.top + rect.height * r.topPct / 100)}px`;
    el.style.bottom = '';
    el.style.width = `${Math.round(rect.width * r.widthPct / 100)}px`;
    el.style.height = `${Math.round(rect.height * r.heightPct / 100)}px`;
    return true;
  }

  function cloneRegion(region) {
    return {
      leftPct: Number(region?.leftPct ?? 0),
      topPct: Number(region?.topPct ?? 0),
      widthPct: Number(region?.widthPct ?? 10),
      heightPct: Number(region?.heightPct ?? 10)
    };
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clampRegion(region) {
    let leftPct = clampNumber(region.leftPct, 0, 99, 0);
    let topPct = clampNumber(region.topPct, 0, 99, 0);
    let widthPct = clampNumber(region.widthPct, 4, 100, 10);
    let heightPct = clampNumber(region.heightPct, 3, 100, 10);
    if (leftPct + widthPct > 100) widthPct = Math.max(4, 100 - leftPct);
    if (topPct + heightPct > 100) heightPct = Math.max(3, 100 - topPct);
    return { leftPct, topPct, widthPct, heightPct };
  }

  function normalizeLayout(candidate) {
    return {
      hardSubMask: clampRegion(cloneRegion(candidate?.hardSubMask || DEFAULT_HARD_SUB_MASK_REGION)),
      subtitleBox: clampRegion(cloneRegion(candidate?.subtitleBox || DEFAULT_SUBTITLE_BOX_REGION))
    };
  }

  function globalLayoutKey() {
    return `layout:${getPlatformId()}:default`;
  }

  function videoLayoutKey(videoId = currentVideoId || extractCurrentVideoId()) {
    return videoId ? `layout:${getPlatformId()}:video:${videoId}` : '';
  }

  function storageGetLocal(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSetLocal(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  async function loadLayoutForCurrentVideo() {
    const vKey = videoLayoutKey();
    const keys = vKey ? [globalLayoutKey(), vKey] : [globalLayoutKey()];
    const stored = await storageGetLocal(keys);
    layout = normalizeLayout((vKey && stored[vKey]) || stored[globalLayoutKey()] || layout);
    return layout;
  }

  async function saveLayout(scope = 'video') {
    const normalized = normalizeLayout(layout);
    layout = normalized;
    const key = scope === 'default' ? globalLayoutKey() : (videoLayoutKey() || globalLayoutKey());
    await storageSetLocal({ [key]: normalized });
    showEditorNotice(scope === 'default' ? `Saved as ${platformLabel()} default.` : 'Saved for this video/lecture.');
  }

  async function saveSettingsFromContent() {
    const res = await sendMessage({ type: 'SAVE_SETTINGS', payload: settings });
    if (res?.ok) settings = { ...DEFAULT_SETTINGS, ...res.settings };
    applyNativeCaptionVisibility();
    updateOverlayStyles();
    updateLayoutStyles();
  }

  function resetLayoutToDefault() {
    layout = normalizeLayout({
      hardSubMask: DEFAULT_HARD_SUB_MASK_REGION,
      subtitleBox: DEFAULT_SUBTITLE_BOX_REGION
    });
    applyLayoutRegions();
  }

  function applyRegion(el, region) {
    if (!el) return;
    if (useFixedUdemyOverlay()) {
      const rect = getLayoutReferenceRect();
      if (applyFixedRegionFromRect(el, region, rect)) return;
    }
    const r = clampRegion(region);
    el.style.position = 'absolute';
    el.style.left = `${r.leftPct}%`;
    el.style.top = `${r.topPct}%`;
    el.style.bottom = '';
    el.style.width = `${r.widthPct}%`;
    el.style.height = `${r.heightPct}%`;
  }

  function isSubtitleDynamicHeightEnabled() {
    return Boolean(settings.subtitleDynamicHeight && !editMode);
  }

  function resolveSubtitleAnchor(region) {
    const mode = settings.subtitleAnchor || 'auto';
    if (mode === 'top' || mode === 'bottom') return mode;
    const r = clampRegion(region || layout.subtitleBox || DEFAULT_SUBTITLE_BOX_REGION);
    return (r.topPct + r.heightPct / 2) >= 56 ? 'bottom' : 'top';
  }

  function getSubtitleMaxHeightPx() {
    const rect = getLayoutReferenceRect();
    const playerHeight = Math.max(160, rect?.height || video?.getBoundingClientRect?.()?.height || window.innerHeight || 540);
    const pct = clampNumber(settings.subtitleMaxHeightPct, 18, 70, 34);
    return Math.max(88, Math.round(playerHeight * pct / 100));
  }

  function applySubtitleRegion(el, region) {
    if (!el) return;
    const r = clampRegion(region);
    const dynamic = isSubtitleDynamicHeightEnabled();
    const fixedUdemy = useFixedUdemyOverlay();
    const refRect = fixedUdemy ? getLayoutReferenceRect() : null;
    el.classList.toggle('ytort-dynamic-height', dynamic);
    el.classList.toggle('ytort-fixed-height', !dynamic);
    el.classList.toggle('ytort-compact-layout', Boolean(settings.subtitleCompactLayout));
    el.classList.toggle('ytort-udemy-fixed-overlay', Boolean(fixedUdemy));
    el.dataset.density = ['comfortable', 'compact', 'ultra'].includes(settings.subtitleDensity) ? settings.subtitleDensity : 'compact';
    el.style.position = fixedUdemy ? 'fixed' : 'absolute';
    if (fixedUdemy && refRect) {
      el.style.left = `${Math.round(refRect.left + refRect.width * r.leftPct / 100)}px`;
      el.style.width = `${Math.round(refRect.width * r.widthPct / 100)}px`;
    } else {
      el.style.left = `${r.leftPct}%`;
      el.style.width = `${r.widthPct}%`;
    }
    el.style.setProperty('--ytort-subtitle-max-height', `${getSubtitleMaxHeightPx()}px`);
    el.style.setProperty('--ytort-fit-scale', '1');
    el.classList.remove('ytort-fit-tight', 'ytort-fit-ultra');
    if (!dynamic) {
      if (fixedUdemy && refRect) {
        el.style.top = `${Math.round(refRect.top + refRect.height * r.topPct / 100)}px`;
        el.style.height = `${Math.round(refRect.height * r.heightPct / 100)}px`;
      } else {
        el.style.top = `${r.topPct}%`;
        el.style.height = `${r.heightPct}%`;
      }
      el.style.bottom = '';
      el.style.alignItems = 'center';
      return;
    }
    el.style.height = 'auto';
    el.style.minHeight = '0px';
    if (resolveSubtitleAnchor(r) === 'bottom') {
      const bottomPct = clampNumber(100 - r.topPct - r.heightPct, 0, 97, 6);
      el.style.top = 'auto';
      if (fixedUdemy && refRect) {
        const bottomPx = Math.max(0, window.innerHeight - (refRect.top + refRect.height * (100 - bottomPct) / 100));
        el.style.bottom = `${Math.round(bottomPx)}px`;
      } else {
        el.style.bottom = `${bottomPct}%`;
      }
      el.style.alignItems = 'flex-end';
    } else {
      if (fixedUdemy && refRect) el.style.top = `${Math.round(refRect.top + refRect.height * r.topPct / 100)}px`;
      else el.style.top = `${r.topPct}%`;
      el.style.bottom = 'auto';
      el.style.alignItems = 'flex-start';
    }
  }

  function applyLayoutRegions() {
    const mask = document.getElementById(MASK_ID);
    const overlay = document.getElementById(OVERLAY_ID);
    applyRegion(mask, layout.hardSubMask);
    applySubtitleRegion(overlay, layout.subtitleBox);
  }

  function fitSubtitleBox() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !isSubtitleDynamicHeightEnabled() || overlay.style.display === 'none') return;
    applySubtitleRegion(overlay, layout.subtitleBox);
    const box = overlay.querySelector('.ytort-box');
    if (!box) return;
    overlay.style.setProperty('--ytort-subtitle-max-height', `${getSubtitleMaxHeightPx()}px`);
    overlay.style.setProperty('--ytort-fit-scale', '1');
    overlay.classList.remove('ytort-fit-tight', 'ytort-fit-ultra');
    requestAnimationFrame(() => {
      if (!overlay.isConnected || !box.isConnected || !isSubtitleDynamicHeightEnabled()) return;
      const maxHeight = getSubtitleMaxHeightPx();
      overlay.style.setProperty('--ytort-subtitle-max-height', `${maxHeight}px`);
      const natural = Math.ceil(box.scrollHeight || box.getBoundingClientRect().height || 0);
      if (natural > maxHeight) overlay.classList.add('ytort-fit-tight');
      requestAnimationFrame(() => {
        if (!overlay.isConnected || !box.isConnected || !isSubtitleDynamicHeightEnabled()) return;
        const afterTight = Math.ceil(box.scrollHeight || box.getBoundingClientRect().height || 0);
        if (afterTight > maxHeight) overlay.classList.add('ytort-fit-ultra');
        clampSubtitleInsidePlayer();
      });
    });
  }

  function clampSubtitleInsidePlayer() {
    const overlay = document.getElementById(OVERLAY_ID);
    const playerRect = getLayoutReferenceRect();
    if (!overlay || !playerRect || !isSubtitleDynamicHeightEnabled() || overlay.style.display === 'none') return;
    const r = clampRegion(layout.subtitleBox);
    const anchor = resolveSubtitleAnchor(r);
    const overlayRect = overlay.getBoundingClientRect();
    const margin = 4;
    if (anchor === 'bottom' && overlayRect.top < playerRect.top + margin) {
      const neededBottomPx = Math.max(margin, playerRect.height - overlayRect.height - margin);
      overlay.style.bottom = `${neededBottomPx}px`;
    } else if (anchor === 'top' && overlayRect.bottom > playerRect.bottom - margin) {
      const neededTopPx = Math.max(margin, playerRect.height - overlayRect.height - margin);
      overlay.style.top = `${neededTopPx}px`;
    }
  }

  function createOverlayIfNeeded() {
    const player = findPlayerMount();
    if (isUdemyPlatform() && !player) return null;
    const temporaryMount = document.body || document.documentElement;
    const mountTarget = player || temporaryMount;
    if (!mountTarget) return null;

    ensureBaseStyles();

    if (player && getComputedStyle(player).position === 'static') {
      try { player.style.position = 'relative'; } catch {}
    }

    let mask = document.getElementById(MASK_ID);
    if (!mask) {
      mask = document.createElement('div');
      mask.id = MASK_ID;
      mask.innerHTML = `
        <div class="ytort-region-label">Hard-sub Cover</div>
        <div class="ytort-handle ytort-handle-tl" data-handle="tl"></div>
        <div class="ytort-handle ytort-handle-tr" data-handle="tr"></div>
        <div class="ytort-handle ytort-handle-bl" data-handle="bl"></div>
        <div class="ytort-handle ytort-handle-br" data-handle="br"></div>
      `;
      mask.addEventListener('mousedown', (event) => startRegionMouseDrag(event, 'mask'));
    }

    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.innerHTML = `
        <div class="ytort-region-label">Subtitle Output</div>
        <div class="ytort-box">
          <div class="ytort-original"></div>
          <div class="ytort-translated"></div>
          <div class="ytort-status"></div>
        </div>
        <div class="ytort-handle ytort-handle-tl" data-handle="tl"></div>
        <div class="ytort-handle ytort-handle-tr" data-handle="tr"></div>
        <div class="ytort-handle ytort-handle-bl" data-handle="bl"></div>
        <div class="ytort-handle ytort-handle-br" data-handle="br"></div>
      `;
      overlay.addEventListener('mousedown', (event) => startRegionMouseDrag(event, 'subtitle'));
    }

    let toggle = document.getElementById(EDIT_TOGGLE_ID);
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.id = EDIT_TOGGLE_ID;
      toggle.type = 'button';
      toggle.textContent = 'Layout';
      toggle.title = 'Edit subtitle layout (Alt+E)';
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleEditMode();
      });
    }

    let toolbar = document.getElementById(EDIT_TOOLBAR_ID);
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = EDIT_TOOLBAR_ID;
      toolbar.innerHTML = `
        <div class="ytort-toolbar-title">Subtitle layout editor</div>
        <div class="ytort-toolbar-hint">Drag boxes. Drag corners to resize. Tab switches target. Arrows move, Shift+Arrows resize.</div>
        <div class="ytort-toolbar-row">
          <button type="button" data-action="select-mask">Mask</button>
          <button type="button" data-action="select-subtitle">Subtitle</button>
          <button type="button" data-action="toggle-mask">Toggle mask</button>
        </div>
        <label class="ytort-toolbar-slider">Opacity <input data-action="opacity" type="range" min="0" max="1" step="0.05"></label>
        <label class="ytort-toolbar-slider">Blur <input data-action="blur" type="range" min="0" max="8" step="1"></label>
        <div class="ytort-toolbar-row">
          <button type="button" data-action="save-video">Save video</button>
          <button type="button" data-action="save-default">Save default</button>
          <button type="button" data-action="reset">Reset</button>
          <button type="button" data-action="cancel">Cancel</button>
        </div>
        <div class="ytort-toolbar-notice"></div>
      `;
      toolbar.addEventListener('mousedown', (event) => event.stopPropagation());
      toolbar.addEventListener('click', handleToolbarClick);
      toolbar.addEventListener('input', handleToolbarInput);
    }

    const fixedUdemy = useFixedUdemyOverlay();
    const fixedMount = document.body || document.documentElement;
    for (const el of [mask, overlay, toggle, toolbar]) {
      const targetMount = fixedUdemy ? fixedMount : (player || mountTarget);
      if (targetMount && el.parentElement !== targetMount) {
        targetMount.appendChild(el);
      } else if (!el.parentElement) {
        mountTarget.appendChild(el);
      }
    }

    updateToolbarInputs();
    applyLayoutRegions();
    updateOverlayStyles();
    updateLayoutStyles();
    updateSelectedRegionClass();
    return overlay;
  }

  function ensureBaseStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${MASK_ID}, #${OVERLAY_ID}, #${EDIT_TOGGLE_ID}, #${EDIT_TOOLBAR_ID} {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        box-sizing: border-box;
      }
      #${MASK_ID} {
        position: absolute;
        background: rgba(0, 0, 0, var(--ytort-mask-opacity, 0.72));
        backdrop-filter: blur(var(--ytort-mask-blur, 2px));
        -webkit-backdrop-filter: blur(var(--ytort-mask-blur, 2px));
        border-radius: var(--ytort-mask-radius, 8px);
        pointer-events: none;
        z-index: 2147483644;
        display: none;
      }
      #${OVERLAY_ID} {
        position: absolute;
        z-index: 2147483645;
        pointer-events: none;
        text-align: center;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0 4px;
        overflow: visible;
        contain: layout style;
      }
      #${OVERLAY_ID}.ytort-dynamic-height {
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
      }
      #${OVERLAY_ID} .ytort-box {
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        gap: 3px;
        max-width: 100%;
        padding: 7px 13px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.62);
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0,0,0,0.9);
        box-decoration-break: clone;
        overflow: visible;
        width: fit-content;
        transform-origin: center bottom;
      }
      #${OVERLAY_ID}.ytort-fixed-height .ytort-box {
        max-height: 100%;
        overflow: hidden;
      }
      #${OVERLAY_ID}.ytort-dynamic-height .ytort-box {
        max-height: none;
        min-height: 0;
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-box,
      #${OVERLAY_ID}[data-density="compact"] .ytort-box {
        gap: 2px;
        padding: 5px 12px 6px;
        border-radius: 7px;
      }
      #${OVERLAY_ID}[data-density="ultra"] .ytort-box,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-box {
        gap: 1px;
        padding: 4px 10px 5px;
        border-radius: 6px;
      }
      #${OVERLAY_ID}.ytort-fit-ultra .ytort-box {
        font-size: 0.88em;
        gap: 0px;
        padding: 3px 9px 4px;
      }
      #${OVERLAY_ID} .ytort-original,
      #${OVERLAY_ID} .ytort-translated {
        color: #fff;
        line-height: 1.22;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
        max-width: 100%;
      }
      #${OVERLAY_ID} .ytort-original {
        color: rgba(255,255,255,0.78);
        font-size: 0.74em;
        line-height: 1.20;
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-original,
      #${OVERLAY_ID}[data-density="compact"] .ytort-original {
        font-size: 0.70em;
        line-height: 1.15;
      }
      #${OVERLAY_ID}[data-density="ultra"] .ytort-original,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-original {
        font-size: 0.66em;
        line-height: 1.10;
      }
      #${OVERLAY_ID} .ytort-translated {
        font-weight: 650;
        line-height: 1.16;
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-translated,
      #${OVERLAY_ID}[data-density="compact"] .ytort-translated {
        line-height: 1.10;
      }
      #${OVERLAY_ID}[data-density="ultra"] .ytort-translated,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-translated {
        font-size: 0.94em;
        line-height: 1.06;
      }
      #${OVERLAY_ID} .ytort-translated.ytort-pending-translation {
        color: transparent;
        text-shadow: none;
        opacity: 0;
      }
      #${OVERLAY_ID} .ytort-study-line {
        display: block;
        text-align: center;
        line-height: 1.22;
        max-width: 100%;
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-study-line,
      #${OVERLAY_ID}[data-density="compact"] .ytort-study-line {
        line-height: 1.15;
      }
      #${OVERLAY_ID}[data-density="ultra"] .ytort-study-line,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-study-line {
        line-height: 1.08;
      }
      #${OVERLAY_ID} .ytort-karaoke-wrap {
        --ytort-karaoke-progress: 0%;
        position: relative;
        display: inline-grid;
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
        overflow: visible;
      }
      #${OVERLAY_ID} .ytort-karaoke-base,
      #${OVERLAY_ID} .ytort-karaoke-active {
        grid-area: 1 / 1;
        display: block;
        max-width: 100%;
      }
      #${OVERLAY_ID} .ytort-karaoke-base {
        color: rgba(255,255,255,0.50);
        filter: saturate(0.72) brightness(0.78);
      }
      #${OVERLAY_ID} .ytort-karaoke-active {
        color: #fff;
        filter: brightness(1.12) saturate(1.08);
        clip-path: inset(0 calc(100% - var(--ytort-karaoke-progress, 0%)) 0 0);
        transition: clip-path 80ms linear;
        will-change: clip-path;
        pointer-events: none;
      }
      #${OVERLAY_ID} .ytort-study-token,
      #${OVERLAY_ID} .ytort-study-chunk {
        line-height: 1.18;
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-study-token,
      #${OVERLAY_ID}.ytort-compact-layout .ytort-study-chunk,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-study-token,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-study-chunk {
        line-height: 1.08;
      }
      #${OVERLAY_ID} .ytort-study-clean .ytort-study-token {
        display: inline;
        padding: 0;
        margin: 0;
        border: 0;
        background: transparent;
      }
      #${OVERLAY_ID} .ytort-study-clean .ytort-study-token-particle,
      #${OVERLAY_ID} .ytort-study-clean .ytort-study-token-auxiliary {
        opacity: 0.94;
      }
      #${OVERLAY_ID} .ytort-study-boxes {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: flex-end;
        gap: 2px 4px;
      }
      #${OVERLAY_ID} .ytort-study-boxes .ytort-karaoke-wrap {
        display: inline-grid;
      }
      #${OVERLAY_ID} .ytort-study-chunk {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 4px 1px;
        margin: 1px 1.5px;
        border-radius: 6px;
        line-height: 1.12;
        border: 1px solid rgba(255,255,255,0.14);
      }
      #${OVERLAY_ID} .ytort-study-token ruby,
      #${OVERLAY_ID} .ytort-study-chunk ruby { ruby-position: over; }
      #${OVERLAY_ID} .ytort-study-token rt,
      #${OVERLAY_ID} .ytort-study-chunk rt {
        font-size: 0.48em;
        line-height: 0.96;
        color: rgba(255,255,255,0.78);
        font-weight: 500;
        text-shadow: 0 1px 2px rgba(0,0,0,0.9);
      }
      #${OVERLAY_ID}.ytort-compact-layout .ytort-study-token rt,
      #${OVERLAY_ID}.ytort-compact-layout .ytort-study-chunk rt,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-study-token rt,
      #${OVERLAY_ID}.ytort-fit-tight .ytort-study-chunk rt {
        font-size: 0.44em;
        line-height: 0.90;
      }
      #${OVERLAY_ID}.ytort-fit-ultra .ytort-study-token rt,
      #${OVERLAY_ID}.ytort-fit-ultra .ytort-study-chunk rt {
        font-size: 0.40em;
      }
      #${OVERLAY_ID} .ytort-karaoke-active rt { color: rgba(255,255,255,0.96); }
      #${OVERLAY_ID}.ytort-seeking .ytort-karaoke-active { transition: none !important; }
      #${OVERLAY_ID} .ytort-study-noun { background: rgba(59,130,246,0.28); }
      #${OVERLAY_ID} .ytort-study-verb { background: rgba(239,68,68,0.30); }
      #${OVERLAY_ID} .ytort-study-particle { background: rgba(234,179,8,0.32); color: #fff7cc; }
      #${OVERLAY_ID} .ytort-study-adjective { background: rgba(168,85,247,0.30); }
      #${OVERLAY_ID} .ytort-study-auxiliary { background: rgba(249,115,22,0.30); }
      #${OVERLAY_ID} .ytort-study-adverb { background: rgba(20,184,166,0.28); }
      #${OVERLAY_ID} .ytort-study-expression { background: rgba(244,114,182,0.28); }
      #${OVERLAY_ID} .ytort-study-symbol { background: transparent; border-color: transparent; padding-left: 0; padding-right: 0; }
      #${OVERLAY_ID} .ytort-study-other { background: rgba(148,163,184,0.22); }
      #${OVERLAY_ID} .ytort-status {
        display: none;
        color: rgba(255,255,255,0.65);
        font-size: 13px;
      }
      .ytort-region-label,
      .ytort-handle { display: none; }
      #${EDIT_TOGGLE_ID} {
        position: absolute;
        right: 12px;
        top: 12px;
        z-index: 2147483647;
        pointer-events: auto;
        border: 1px solid rgba(255,255,255,0.28);
        background: rgba(0,0,0,0.45);
        color: #fff;
        border-radius: 999px;
        padding: 5px 9px;
        font-size: 12px;
        font-weight: 650;
        cursor: pointer;
        opacity: 0.45;
      }
      #${EDIT_TOGGLE_ID}:hover { opacity: 1; }
      #${EDIT_TOOLBAR_ID} {
        position: absolute;
        left: 12px;
        top: 12px;
        width: 315px;
        z-index: 2147483647;
        pointer-events: auto;
        display: none;
        background: rgba(10, 14, 20, 0.92);
        color: #f8fafc;
        border: 1px solid rgba(148,163,184,0.36);
        border-radius: 12px;
        padding: 10px;
        box-shadow: 0 14px 40px rgba(0,0,0,0.42);
        text-align: left;
        font-size: 12px;
      }
      #${EDIT_TOOLBAR_ID} .ytort-toolbar-title { font-size: 13px; font-weight: 800; margin-bottom: 4px; }
      #${EDIT_TOOLBAR_ID} .ytort-toolbar-hint { color: #cbd5e1; line-height: 1.35; margin-bottom: 8px; }
      #${EDIT_TOOLBAR_ID} .ytort-toolbar-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0; }
      #${EDIT_TOOLBAR_ID} button {
        border: 1px solid rgba(148,163,184,0.35);
        background: rgba(30,41,59,0.92);
        color: #f8fafc;
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 650;
      }
      #${EDIT_TOOLBAR_ID} button:hover { filter: brightness(1.15); }
      #${EDIT_TOOLBAR_ID} .ytort-toolbar-slider { display: flex; align-items: center; gap: 8px; margin: 7px 0; color: #dbe4ef; }
      #${EDIT_TOOLBAR_ID} input[type="range"] { flex: 1; }
      #${EDIT_TOOLBAR_ID} .ytort-toolbar-notice { min-height: 16px; color: #a7f3d0; margin-top: 4px; }
      .ytort-layout-editing #${MASK_ID},
      .ytort-layout-editing #${OVERLAY_ID} {
        pointer-events: auto;
      }
      .ytort-layout-editing #${MASK_ID} {
        display: block !important;
        outline: 2px dashed #22d3ee;
        cursor: move;
      }
      .ytort-layout-editing #${OVERLAY_ID} {
        display: flex !important;
        outline: 2px dashed #facc15;
        cursor: move;
      }
      .ytort-layout-editing #${OVERLAY_ID} .ytort-box {
        min-width: 220px;
      }
      .ytort-layout-editing .ytort-region-label {
        display: block;
        position: absolute;
        left: 6px;
        top: -22px;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(15,23,42,0.9);
        color: #fff;
        font-size: 11px;
        font-weight: 750;
        pointer-events: none;
        white-space: nowrap;
      }
      .ytort-layout-editing .ytort-handle {
        display: block;
        position: absolute;
        width: 12px;
        height: 12px;
        border: 2px solid #fff;
        background: #0ea5e9;
        border-radius: 50%;
        z-index: 2;
        pointer-events: auto;
      }
      .ytort-handle-tl { left: -7px; top: -7px; cursor: nwse-resize; }
      .ytort-handle-tr { right: -7px; top: -7px; cursor: nesw-resize; }
      .ytort-handle-bl { left: -7px; bottom: -7px; cursor: nesw-resize; }
      .ytort-handle-br { right: -7px; bottom: -7px; cursor: nwse-resize; }
      .ytort-layout-editing #${MASK_ID}.ytort-selected-region { outline: 3px solid #22d3ee; }
      .ytort-layout-editing #${OVERLAY_ID}.ytort-selected-region { outline: 3px solid #facc15; }
    `;
    document.documentElement.appendChild(style);
  }

  function updateOverlayStyles() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.style.fontSize = `${settings.overlayFontSize || 22}px`;
    applySubtitleRegion(overlay, layout.subtitleBox);
  }

  function updateUdemyFixedControls() {
    if (!useFixedUdemyOverlay()) return;
    const rect = getLayoutReferenceRect();
    const toggle = document.getElementById(EDIT_TOGGLE_ID);
    const toolbar = document.getElementById(EDIT_TOOLBAR_ID);
    if (!rect) return;
    if (toggle) {
      toggle.style.position = 'fixed';
      toggle.style.left = `${Math.max(8, Math.round(rect.right - 86))}px`;
      toggle.style.right = 'auto';
      toggle.style.top = `${Math.max(8, Math.round(rect.top + 12))}px`;
    }
    if (toolbar) {
      toolbar.style.position = 'fixed';
      toolbar.style.left = `${Math.max(8, Math.round(rect.left + 12))}px`;
      toolbar.style.top = `${Math.max(8, Math.round(rect.top + 12))}px`;
    }
  }

  function updateLayoutStyles() {
    const mask = document.getElementById(MASK_ID);
    const toolbar = document.getElementById(EDIT_TOOLBAR_ID);
    const opacity = clampNumber(settings.hardSubMaskOpacity, 0, 1, 0.72);
    const blur = clampNumber(settings.hardSubMaskBlur, 0, 8, 2);
    const radius = clampNumber(settings.hardSubMaskRadius, 0, 32, 8);
    if (mask) {
      mask.style.setProperty('--ytort-mask-opacity', String(opacity));
      mask.style.setProperty('--ytort-mask-blur', `${blur}px`);
      mask.style.setProperty('--ytort-mask-radius', `${radius}px`);
      mask.style.display = settings.coverHardSub || editMode ? 'block' : 'none';
    }
    if (toolbar) toolbar.style.display = editMode ? 'block' : 'none';
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) applySubtitleRegion(overlay, layout.subtitleBox);
    updateUdemyFixedControls();
    document.documentElement.classList.toggle('ytort-layout-editing', editMode);
    const toggle = document.getElementById(EDIT_TOGGLE_ID);
    if (toggle) toggle.textContent = editMode ? 'Editing' : 'Layout';
    updateToolbarInputs();
  }

  function updateToolbarInputs() {
    const toolbar = document.getElementById(EDIT_TOOLBAR_ID);
    if (!toolbar) return;
    const opacity = toolbar.querySelector('input[data-action="opacity"]');
    const blur = toolbar.querySelector('input[data-action="blur"]');
    if (opacity) opacity.value = String(clampNumber(settings.hardSubMaskOpacity, 0, 1, 0.72));
    if (blur) blur.value = String(clampNumber(settings.hardSubMaskBlur, 0, 8, 2));
  }

  function showEditorNotice(text) {
    const notice = document.querySelector(`#${EDIT_TOOLBAR_ID} .ytort-toolbar-notice`);
    if (!notice) return;
    notice.textContent = text;
    clearTimeout(showEditorNotice._timer);
    showEditorNotice._timer = setTimeout(() => {
      if (notice.textContent === text) notice.textContent = '';
    }, 2200);
  }

  function setSelectedLayoutTarget(target) {
    selectedLayoutTarget = target === 'subtitle' ? 'subtitle' : 'mask';
    updateSelectedRegionClass();
  }

  function updateSelectedRegionClass() {
    const mask = document.getElementById(MASK_ID);
    const overlay = document.getElementById(OVERLAY_ID);
    if (mask) mask.classList.toggle('ytort-selected-region', selectedLayoutTarget === 'mask');
    if (overlay) overlay.classList.toggle('ytort-selected-region', selectedLayoutTarget === 'subtitle');
  }

  function toggleEditMode(force) {
    const next = typeof force === 'boolean' ? force : !editMode;
    if (next === editMode) return;
    if (next) {
      layoutBeforeEdit = normalizeLayout(layout);
      editMode = true;
      createOverlayIfNeeded();
      renderEditPreview();
    } else {
      editMode = false;
      layoutBeforeEdit = null;
      renderNow(true);
    }
    updateLayoutStyles();
    updateSelectedRegionClass();
  }

  function cancelEditMode() {
    if (layoutBeforeEdit) {
      layout = normalizeLayout(layoutBeforeEdit);
      applyLayoutRegions();
    }
    editMode = false;
    layoutBeforeEdit = null;
    updateLayoutStyles();
    renderNow(true);
  }

  function renderEditPreview() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    const originalEl = overlay.querySelector('.ytort-original');
    const translatedEl = overlay.querySelector('.ytort-translated');
    const statusEl = overlay.querySelector('.ytort-status');
    if (originalEl) {
      originalEl.style.display = 'block';
      originalEl.textContent = 'Original subtitle preview';
    }
    if (translatedEl) translatedEl.textContent = 'Bản dịch phụ đề sẽ hiển thị ở đây';
    if (statusEl) statusEl.style.display = 'none';
    overlay.style.display = 'flex';
    fitSubtitleBox();
  }

  function handleToolbarClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const action = button.dataset.action;
    if (action === 'select-mask') setSelectedLayoutTarget('mask');
    else if (action === 'select-subtitle') setSelectedLayoutTarget('subtitle');
    else if (action === 'toggle-mask') {
      settings.coverHardSub = !settings.coverHardSub;
      saveSettingsFromContent();
      showEditorNotice(settings.coverHardSub ? 'Mask enabled.' : 'Mask disabled.');
    } else if (action === 'save-video') {
      saveLayout('video');
      layoutBeforeEdit = normalizeLayout(layout);
    } else if (action === 'save-default') {
      saveLayout('default');
      layoutBeforeEdit = normalizeLayout(layout);
    } else if (action === 'reset') {
      resetLayoutToDefault();
      renderEditPreview();
      showEditorNotice('Layout reset. Save to keep it.');
    } else if (action === 'cancel') {
      cancelEditMode();
    }
  }

  function handleToolbarInput(event) {
    const input = event.target.closest('input[data-action]');
    if (!input) return;
    const action = input.dataset.action;
    if (action === 'opacity') settings.hardSubMaskOpacity = clampNumber(input.value, 0, 1, 0.72);
    if (action === 'blur') settings.hardSubMaskBlur = clampNumber(input.value, 0, 8, 2);
    updateLayoutStyles();
    saveSettingsFromContent();
  }

  function startRegionMouseDrag(event, target) {
    if (!editMode) return;
    const toolbar = document.getElementById(EDIT_TOOLBAR_ID);
    if (toolbar && toolbar.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedLayoutTarget(target);
    const handle = event.target?.dataset?.handle || '';
    const mode = handle ? 'resize' : 'move';
    dragState = {
      target,
      mode,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRegion: cloneRegion(target === 'mask' ? layout.hardSubMask : layout.subtitleBox)
    };
    document.addEventListener('mousemove', handleRegionMouseMove, true);
    document.addEventListener('mouseup', stopRegionMouseDrag, true);
  }

  function getPlayerRect() {
    return getLayoutReferenceRect();
  }

  function updateDraggedRegion(dxPct, dyPct) {
    if (!dragState) return;
    const start = dragState.startRegion;
    const r = { ...start };
    if (dragState.mode === 'move') {
      r.leftPct = start.leftPct + dxPct;
      r.topPct = start.topPct + dyPct;
    } else {
      const h = dragState.handle;
      if (h.includes('l')) {
        r.leftPct = start.leftPct + dxPct;
        r.widthPct = start.widthPct - dxPct;
      }
      if (h.includes('r')) {
        r.widthPct = start.widthPct + dxPct;
      }
      if (h.includes('t')) {
        r.topPct = start.topPct + dyPct;
        r.heightPct = start.heightPct - dyPct;
      }
      if (h.includes('b')) {
        r.heightPct = start.heightPct + dyPct;
      }
    }
    const clamped = clampRegion(r);
    if (dragState.target === 'mask') layout.hardSubMask = clamped;
    else layout.subtitleBox = clamped;
    applyLayoutRegions();
    renderEditPreview();
  }

  function handleRegionMouseMove(event) {
    if (!dragState) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = getPlayerRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const dxPct = ((event.clientX - dragState.startX) / rect.width) * 100;
    const dyPct = ((event.clientY - dragState.startY) / rect.height) * 100;
    updateDraggedRegion(dxPct, dyPct);
  }

  function stopRegionMouseDrag(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    dragState = null;
    document.removeEventListener('mousemove', handleRegionMouseMove, true);
    document.removeEventListener('mouseup', stopRegionMouseDrag, true);
  }

  function nudgeSelectedRegion(event) {
    const target = selectedLayoutTarget === 'subtitle' ? 'subtitleBox' : 'hardSubMask';
    const r = { ...layout[target] };
    const step = event.ctrlKey || event.metaKey ? 2 : 0.75;
    const resize = event.shiftKey;
    if (event.key === 'ArrowLeft') resize ? (r.widthPct -= step) : (r.leftPct -= step);
    if (event.key === 'ArrowRight') resize ? (r.widthPct += step) : (r.leftPct += step);
    if (event.key === 'ArrowUp') resize ? (r.heightPct -= step) : (r.topPct -= step);
    if (event.key === 'ArrowDown') resize ? (r.heightPct += step) : (r.topPct += step);
    layout[target] = clampRegion(r);
    applyLayoutRegions();
    renderEditPreview();
  }

  function setupLayoutKeyboardShortcuts() {
    document.addEventListener('keydown', async (event) => {
      const key = event.key;
      if ((event.altKey || event.metaKey) && key.toLowerCase() === 'e') {
        event.preventDefault();
        event.stopPropagation();
        toggleEditMode();
        return;
      }
      if ((event.altKey || event.metaKey) && key.toLowerCase() === 'h') {
        event.preventDefault();
        event.stopPropagation();
        settings.coverHardSub = !settings.coverHardSub;
        await saveSettingsFromContent();
        showEditorNotice(settings.coverHardSub ? 'Mask enabled.' : 'Mask disabled.');
        return;
      }
      if (!editMode) return;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelEditMode();
        return;
      }
      if (key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        setSelectedLayoutTarget(selectedLayoutTarget === 'mask' ? 'subtitle' : 'mask');
        return;
      }
      if ((event.altKey || event.metaKey) && key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        await saveLayout('video');
        layoutBeforeEdit = normalizeLayout(layout);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        nudgeSelectedRegion(event);
      }
    }, true);
  }

  function applyNativeCaptionVisibility() {
    let style = document.getElementById(NATIVE_HIDE_STYLE_ID);
    const shouldHide = isUdemyPlatform() ? settings.hideUdemyNativeCaptions : settings.hideNativeCaptions;
    if (shouldHide) {
      if (!style) {
        style = document.createElement('style');
        style.id = NATIVE_HIDE_STYLE_ID;
        document.documentElement.appendChild(style);
      }
      if (isUdemyPlatform()) {
        // Conservative Udemy selectors. Default is OFF because Udemy player UI
        // changes often and we do not want to hide controls by accident.
        style.textContent = `
          [data-purpose*="caption"],
          [class*="caption-display"],
          [class*="captions-display"],
          [class*="subtitle-display"],
          [class*="captions-cue"],
          [class*="captions"] [class*="cue"] {
            display: none !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
        `;
      } else {
        // Hide YouTube's native caption DOM only. Our overlay lives outside these
        // containers, so it remains visible. YouTube changes class names between
        // caption modes, so keep this selector list broad but scoped to the player.
        style.textContent = `
          .html5-video-player .ytp-caption-window-container,
          .html5-video-player .ytp-caption-window-rollup,
          .html5-video-player .ytp-caption-window-bottom,
          .html5-video-player .caption-window,
          .html5-video-player .caption-window.ytp-caption-window-bottom,
          .html5-video-player caption-window,
          .html5-video-player .caption-visual-line,
          .html5-video-player .ytp-caption-segment,
          #movie_player .ytp-caption-window-container,
          #movie_player .ytp-caption-window-rollup,
          #movie_player .ytp-caption-window-bottom,
          #movie_player .caption-window,
          #movie_player caption-window,
          #movie_player .caption-visual-line,
          #movie_player .ytp-caption-segment {
            display: none !important;
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
        `;
      }
    } else if (style) {
      style.remove();
    }
  }

  function renderNow(force = false) {
    const overlay = createOverlayIfNeeded();
    if (!overlay) return;
    if (!isPlatformEnabled()) {
      overlay.style.display = editMode ? 'flex' : 'none';
      if (editMode) renderEditPreview();
      return;
    }

    if (editMode) {
      renderEditPreview();
      return;
    }

    const now = performance.now();
    const minFrameMs = settings.studySpeakingHighlight ? 35 : 80;
    if (!force && now - lastRenderTick < minFrameMs) return;
    lastRenderTick = now;
    overlay.classList.toggle('ytort-seeking', seekingInProgress);

    const originalEl = overlay.querySelector('.ytort-original');
    const translatedEl = overlay.querySelector('.ytort-translated');
    const statusEl = overlay.querySelector('.ytort-status');
    const currentTime = getCurrentTime();
    const cue = findStableActiveCue(currentTime);

    if (!cue) {
      const t = getCurrentTime();
      let idleStatus = '';
      if (!cues.length && statusMessage) {
        idleStatus = statusMessage;
      } else if (isUdemyPlatform() && cues.length && settings.debug) {
        const first = cues[0];
        const last = cues[cues.length - 1];
        idleStatus = `Loaded ${cues.length} Udemy cues, waiting at ${t.toFixed(1)}s. Range ${getCueDisplayStart(first).toFixed(1)}–${getCueDisplayEnd(last).toFixed(1)}s.`;
      }
      const shouldShowStatus = Boolean(idleStatus);
      originalEl.textContent = '';
      originalEl.classList.remove('ytort-study-line', 'ytort-study-clean', 'ytort-study-boxes', 'ytort-karaoke-line');
      translatedEl.classList.remove('ytort-pending-translation');
      translatedEl.textContent = shouldShowStatus ? idleStatus : '';
      statusEl.textContent = '';
      statusEl.style.display = 'none';
      overlay.style.display = shouldShowStatus ? 'flex' : 'none';
      activeCueId = null;
      activeTranslated = null;
      return;
    }

    const hasTranslation = Boolean(cue.translated);
    const isPendingTranslation = pendingIds.has(cue.id);
    const translated = cue.translated || '';
    const studyProgressKey = getStudySpeakingKey(cue, currentTime);
    if (!force && activeCueId === cue.id && activeTranslated === translated && activeStudyProgressKey === studyProgressKey) return;

    activeCueId = cue.id;
    activeTranslated = translated;
    activeStudyProgressKey = studyProgressKey;
    renderOriginalSubtitle(originalEl, cue);
    translatedEl.classList.toggle('ytort-pending-translation', !hasTranslation && isPendingTranslation);
    // Never show a visible pending placeholder such as "...". On Udemy the
    // current cue can arrive before translation, so visibility must be driven by
    // the original cue, not by translation state. Keep a non-breaking space to
    // reserve stable layout height until the translated text is ready.
    const visibleError = !isUdemyPlatform() && statusMessage && /^Translation error:/i.test(statusMessage);
    translatedEl.textContent = translated || (visibleError ? statusMessage : ' ');
    statusEl.textContent = '';
    statusEl.style.display = 'none';
    overlay.style.display = 'flex';
    fitSubtitleBox();

    // If the current cue reached the screen before the scheduler got to it,
    // trigger a high-priority fill. This removes the visible "..."/blank flash
    // on Udemy when a new lecture starts or the user seeks into an untranslated cue.
    if (!hasTranslation && !isPendingTranslation && Date.now() - lastUrgentScheduleAt > 350) {
      lastUrgentScheduleAt = Date.now();
      scheduleAhead(true);
    }
  }

  function getCueIndexById(id) {
    const cue = cueMap.get(id);
    return cue ? cue.index : -1;
  }

  function getContextForCandidates(candidates) {
    if (!candidates.length) return { previousContext: [], futureContext: [] };
    const firstIndex = getCueIndexById(candidates[0].id);
    const lastIndex = getCueIndexById(candidates[candidates.length - 1].id);
    const previousContext = cues
      .slice(Math.max(0, firstIndex - 5), Math.max(0, firstIndex))
      .map((cue) => cue.text)
      .filter(Boolean);
    const futureContext = cues
      .slice(lastIndex + 1, Math.min(cues.length, lastIndex + 6))
      .map((cue) => cue.text)
      .filter(Boolean);
    return { previousContext, futureContext };
  }

  async function scheduleAhead(force = false) {
    if (!isPlatformEnabled() || !cues.length) return;
    if (translateInFlight) {
      if (force) pendingUrgentTranslation = true;
      return;
    }
    const nowMs = Date.now();
    if (!force && nowMs - lastScheduleAt < 900) return;
    lastScheduleAt = nowMs;

    const currentTime = getCurrentTime();
    const ahead = Number(settings.aheadSeconds || 60);
    const batchSize = Number(settings.batchSize || 12);

    const currentCueForPriority = isUdemyPlatform() ? findStableActiveCue(currentTime) : findActiveCue(currentTime);
    const candidates = cues
      .filter((cue) => cue.end >= currentTime - 0.5)
      .filter((cue) => cue.start <= currentTime + ahead)
      .filter((cue) => cue.text && !cue.translated && !pendingIds.has(cue.id))
      .sort((a, b) => {
        if (currentCueForPriority && a.id === currentCueForPriority.id) return -1;
        if (currentCueForPriority && b.id === currentCueForPriority.id) return 1;
        return Math.abs(getCueDisplayStart(a) - currentTime) - Math.abs(getCueDisplayStart(b) - currentTime);
      })
      .slice(0, batchSize);

    if (!candidates.length) return;

    for (const cue of candidates) pendingIds.add(cue.id);
    renderNow(true);
    translateInFlight = true;

    const { previousContext, futureContext } = getContextForCandidates(candidates);
    const res = await sendMessage({
      type: 'TRANSLATE_BATCH',
      payload: {
        videoId: `${getPlatformId()}:${currentVideoId || extractCurrentVideoId()}`,
        sourceLang: currentSourceLang,
        targetLang: settings.targetLang,
        previousContext,
        futureContext,
        items: candidates.map((cue) => ({ id: cue.id, text: cue.text, start: cue.start, end: cue.end }))
      }
    });

    translateInFlight = false;
    const rerunUrgent = pendingUrgentTranslation;
    pendingUrgentTranslation = false;
    if (!res?.ok) {
      console.warn('[Video-Translator] Translate batch failed:', res?.error);
      statusMessage = `Translation error: ${res?.error || 'unknown error'}`;
      for (const cue of candidates) pendingIds.delete(cue.id);
      renderNow(true);
      if (rerunUrgent) setTimeout(() => scheduleAhead(true), 0);
      return;
    }

    const translations = res.translations || {};
    for (const cue of candidates) {
      pendingIds.delete(cue.id);
      if (translations[cue.id]) {
        cue.translated = translations[cue.id];
      }
    }
    renderNow(true);
    if (rerunUrgent) setTimeout(() => scheduleAhead(true), 0);
    // Keep filling the ahead window while playback continues.
    setTimeout(() => scheduleAhead(false), 50);
  }

  function watchUrlChanges() {
    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const nextVideoId = extractCurrentVideoId();
        if (nextVideoId !== currentVideoId) resetForVideo(nextVideoId);
      }
    };
    const wrap = (fnName) => {
      const original = history[fnName];
      history[fnName] = function patchedHistory() {
        const ret = original.apply(this, arguments);
        setTimeout(check, 0);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', check);
    document.addEventListener('yt-navigate-finish', check);
    document.addEventListener('udemy:lecture-change', check);
    setInterval(() => {
      check();
      const nextVideoId = extractCurrentVideoId();
      if (nextVideoId && nextVideoId !== currentVideoId) resetForVideo(nextVideoId);
    }, 1000);
  }

  function requestTimingRenderLoop() {
    if (timingRafId) return;
    timingRafId = requestAnimationFrame(renderTimingFrame);
  }

  function renderTimingFrame() {
    timingRafId = 0;
    renderNow(false);
    const v = findVideo();
    if (v && !v.paused && !v.ended) requestTimingRenderLoop();
  }

  function clearCueRenderState({ keepUdemyLastCue = false } = {}) {
    activeCueId = null;
    activeTranslated = null;
    activeStudyProgressKey = null;
    lastVisibleCue = null;
    lastVisibleCueWallTime = 0;
    if (isUdemyPlatform() && !keepUdemyLastCue) {
      udemyRenderState.lastRenderableCue = null;
      udemyRenderState.lastRenderableAt = 0;
    }
  }

  function setSeekingTransitionState(value) {
    seekingInProgress = Boolean(value);
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.classList.toggle('ytort-seeking', seekingInProgress);
  }

  function bindVideoTimingEvents() {
    const v = findVideo();
    if (!v || v === timingEventsVideo) return;
    if (timingEventsVideo) {
      timingEventsVideo.removeEventListener('play', requestTimingRenderLoop);
      timingEventsVideo.removeEventListener('playing', requestTimingRenderLoop);
      timingEventsVideo.removeEventListener('timeupdate', handleVideoTimeUpdate);
      timingEventsVideo.removeEventListener('pause', handleVideoPause);
      timingEventsVideo.removeEventListener('seeking', handleVideoSeeking);
      timingEventsVideo.removeEventListener('seeked', handleVideoSeeked);
      timingEventsVideo.removeEventListener('ratechange', handleVideoTimeUpdate);
      timingEventsVideo.removeEventListener('loadedmetadata', handleVideoMetadataLoaded);
      timingEventsVideo.removeEventListener('emptied', handleVideoEmptied);
    }
    timingEventsVideo = v;
    v.addEventListener('play', requestTimingRenderLoop);
    v.addEventListener('playing', requestTimingRenderLoop);
    v.addEventListener('timeupdate', handleVideoTimeUpdate);
    v.addEventListener('pause', handleVideoPause);
    v.addEventListener('seeking', handleVideoSeeking);
    v.addEventListener('seeked', handleVideoSeeked);
    v.addEventListener('ratechange', handleVideoTimeUpdate);
    v.addEventListener('loadedmetadata', handleVideoMetadataLoaded);
    v.addEventListener('emptied', handleVideoEmptied);
    if (!v.paused && !v.ended) requestTimingRenderLoop();
  }

  function handleVideoMetadataLoaded() {
    if (isUdemyPlatform()) {
      currentVideoId = extractCurrentVideoId();
      discoverUdemyCaptions(true);
    }
    renderNow(true);
  }

  function handleVideoEmptied() {
    if (isUdemyPlatform()) {
      logUdemyRenderState('video-emptied', { lectureKey: extractCurrentVideoId() }, 500);
      // Udemy can emit `emptied` during internal HLS/player re-renders without a
      // real lecture change. Keep cue state; URL watcher will reset on actual
      // lecture navigation.
      setTimeout(() => { bindVideoTimingEvents(); renderNow(true); }, 120);
      return;
    }
    resetForVideo(extractCurrentVideoId());
  }

  function handleVideoTimeUpdate() {
    renderNow(true);
    if (timingEventsVideo && !timingEventsVideo.paused && !timingEventsVideo.ended) requestTimingRenderLoop();
  }

  function handleVideoPause() {
    renderNow(true);
  }

  function handleVideoSeeking() {
    if (seekTransitionTimer) clearTimeout(seekTransitionTimer);
    setSeekingTransitionState(true);
    clearCueRenderState();
    renderNow(true);
  }

  function handleVideoSeeked() {
    clearCueRenderState();
    renderNow(true);
    if (seekTransitionTimer) clearTimeout(seekTransitionTimer);
    seekTransitionTimer = setTimeout(() => {
      setSeekingTransitionState(false);
      clearCueRenderState();
      renderNow(true);
      if (timingEventsVideo && !timingEventsVideo.paused && !timingEventsVideo.ended) requestTimingRenderLoop();
    }, 120);
  }

  function bootLoops() {
    setInterval(() => {
      findVideo();
      bindVideoTimingEvents();
      createOverlayIfNeeded();
      if (isUdemyPlatform()) discoverUdemyCaptions(false);
      renderNow(false);
    }, 180);

    setInterval(() => {
      scheduleAhead(false);
    }, 1000);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || (data.source !== MAIN_SOURCE && data.source !== UDEMY_MAIN_SOURCE)) return;
    if (data.type === 'UDEMY_PAGE_FETCH_TEXT_RESULT') {
      handleUdemyPageFetchResult(data.payload || {});
    } else if (data.type === 'YOUTUBE_TIMEDTEXT_RESPONSE') {
      await handleTimedTextPayload(data.payload);
    } else if (data.type === 'UDEMY_CAPTION_FILE') {
      await handleUdemyCaptionFile(data.payload || {});
    } else if (data.type === 'UDEMY_CAPTION_CANDIDATES') {
      await handleUdemyCaptionCandidates(data.payload || {});
    } else if (data.type === 'UDEMY_MAIN_READY') {
      discoverUdemyCaptions(true);
    }
  });

  (async function init() {
    try { console.debug('[Video-Translator] content loaded', { platform: getPlatformId(), href: location.href, frame: window === window.top ? 'top' : 'child' }); } catch {}
    currentVideoId = extractCurrentVideoId();
    statusMessage = getDefaultStatusMessage();
    await loadSettings();
    await loadLayoutForCurrentVideo();
    watchUrlChanges();
    setupLayoutKeyboardShortcuts();
    window.addEventListener('resize', () => { applyLayoutRegions(); updateLayoutStyles(); renderNow(true); }, { passive: true });
    window.addEventListener('scroll', () => { if (isUdemyPlatform()) { applyLayoutRegions(); updateLayoutStyles(); renderNow(true); } }, { passive: true, capture: true });
    bootLoops();
    createOverlayIfNeeded();
    if (isUdemyPlatform()) discoverUdemyCaptions(true);
    renderNow(true);
  })();
})();
