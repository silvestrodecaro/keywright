'use strict';

(function (root, factory) {
  const exports = factory();
  if (typeof module === 'object' && module.exports)
    module.exports = exports;
  else
    root.KeywrightSettings = exports;
})(typeof window === 'object' ? window : globalThis, function () {
  function readSetting(storage, key) {
    try {
      const current = storage.getItem(key);
      if (current !== null || !key.startsWith('keywright.')) return current;
      const previous = storage.getItem('rfide.' + key.slice('keywright.'.length));
      if (previous !== null) {
        try { storage.setItem(key, previous); } catch { /* Keep reading the old value if storage is full. */ }
      }
      return previous;
    } catch {
      return null;
    }
  }
  return { readSetting };
});
