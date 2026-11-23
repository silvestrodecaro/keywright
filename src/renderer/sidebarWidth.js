'use strict';

// Sidebar width: drag its right edge; double-click resets it. The width is kept in
// localStorage and applied through the --sidebar-width CSS variable.
(function (factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    window.RFSidebarWidth = factory();
})(function () {
  const SIDEBAR_DEFAULT = 290;
  const SIDEBAR_MIN = 250;
  const KEY = 'keywright.sidebarWidth';

  /** The width shown for `width`: at least 250 px and at most 60% of the window. */
  function clampWidth(width, windowWidth) {
    const max = Math.max(SIDEBAR_MIN, Math.round(windowWidth * 0.6));
    return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(width)));
  }

  /** The stored width, or the default when none is stored or storage is unavailable. */
  function storedWidth(storage) {
    let stored = NaN;
    try {
      stored = Number(storage.getItem(KEY));
    } catch {
      // default width
    }
    return stored > 0 ? stored : SIDEBAR_DEFAULT;
  }

  function install() {
    const $ = (selector) => document.querySelector(selector);

    function setSidebarWidth(width) {
      width = clampWidth(width, window.innerWidth);
      document.documentElement.style.setProperty('--sidebar-width', width + 'px');
      return width;
    }

    function storeSidebarWidth(width) {
      try {
        localStorage.setItem(KEY, String(width));
      } catch {
        // not kept
      }
    }

    // Read inside storedWidth's try: the localStorage accessor itself can throw.
    let width = setSidebarWidth(storedWidth({ getItem: (key) => localStorage.getItem(key) }));
    const resizer = $('#sidebar-resizer');
    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0)
        return;
      event.preventDefault();
      // Captured, so the pointer is not lost over the trace viewer's or the report's iframe.
      resizer.setPointerCapture(event.pointerId);
      resizer.classList.add('is-dragging');
      const left = $('.sidebar').getBoundingClientRect().left;
      const move = (e) => { width = setSidebarWidth(e.clientX - left); };
      const end = () => {
        resizer.classList.remove('is-dragging');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', end);
        resizer.removeEventListener('pointercancel', end);
        storeSidebarWidth(width);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', end);
      resizer.addEventListener('pointercancel', end);
    });
    resizer.addEventListener('dblclick', () => {
      width = setSidebarWidth(SIDEBAR_DEFAULT);
      storeSidebarWidth(width);
    });
    window.addEventListener('resize', () => setSidebarWidth(width));
  }

  return { install, clampWidth, storedWidth, SIDEBAR_DEFAULT };
});
