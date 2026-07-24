(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  function toHttpHeaderValue(value) {
    const text = String(value ?? '')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .trim();
    if (!text || /[\r\n]/.test(text)) return '';
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) > 0xff) return '';
    }
    return text;
  }

  function sanitizeHeaders(input) {
    if (!input) return input;
    const output = {};
    const add = (name, value) => {
      const safeName = String(name ?? '').trim();
      const safeValue = toHttpHeaderValue(value);
      if (!safeName || !safeValue || /^Bearer\s*$/i.test(safeValue)) return;
      output[safeName] = safeValue;
    };

    if (input instanceof Headers) {
      input.forEach((value, name) => add(name, value));
    } else if (Array.isArray(input)) {
      input.forEach((entry) => {
        if (Array.isArray(entry) && entry.length >= 2) add(entry[0], entry[1]);
      });
    } else if (typeof input === 'object') {
      Object.entries(input).forEach(([name, value]) => add(name, value));
    }
    return output;
  }

  globalThis.fetch = function safeFetch(input, init) {
    if (!init?.headers) return nativeFetch(input, init);
    return nativeFetch(input, { ...init, headers: sanitizeHeaders(init.headers) });
  };

  importScripts('background.js');
})();
