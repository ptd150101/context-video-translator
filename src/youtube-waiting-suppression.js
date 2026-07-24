(() => {
  if (window.__YTORT_WAITING_SUPPRESSION__) return;
  window.__YTORT_WAITING_SUPPRESSION__ = true;

  const OVERLAY_ID = 'yt-openai-realtime-translator-overlay';
  const HIDDEN_CLASS = 'ytort-no-caption-state';
  const ROUTINE_NO_CAPTION_RE = /(?:waiting[^.]*captions?|waiting[^.]*first[^.]*caption|turn captions? on|captions?\s+(?:are\s+)?(?:unavailable|not available|disabled)|subtitles?\s+(?:are\s+)?(?:unavailable|not available|disabled)|no (?:youtube\s+)?captions? (?:found|available)|caption track (?:is\s+)?unavailable)/i;

  const style = document.createElement('style');
  style.textContent = `#${OVERLAY_ID}.${HIDDEN_CLASS}{display:none!important;visibility:hidden!important;pointer-events:none!important;}`;
  (document.head || document.documentElement).appendChild(style);

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function updateVisibility() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;

    const original = normalizeText(overlay.querySelector('.ytort-original')?.textContent);
    const translated = normalizeText(overlay.querySelector('.ytort-translated')?.textContent);
    const combined = normalizeText(`${original} ${translated}`);
    const hasRealCaption = Boolean(original);
    const shouldHide = !hasRealCaption && (!combined || ROUTINE_NO_CAPTION_RE.test(combined));

    overlay.classList.toggle(HIDDEN_CLASS, shouldHide);
  }

  const observer = new MutationObserver(updateVisibility);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  });

  setInterval(updateVisibility, 250);
  updateVisibility();
})();
