'use strict';

// Forward renderer and child-process failures through the main process: on
// Windows their stderr is not reliably inherited by the source launcher.
// onEvent receives the same events, e.g. for local crash reports.
function installStartupDiagnostics(app, { onEvent = () => {} } = {}) {
  const log = (event, details = {}) => {
    console.error(`[startup] ${event} ${JSON.stringify(details)}`);
    onEvent(event, details);
  };
  app.whenReady().then(() => log('runtime', {
    electron: process.versions.electron, chromium: process.versions.chrome,
    platform: process.platform, architecture: process.arch,
    gpu: app.getGPUFeatureStatus(),
  }));
  app.on('child-process-gone', (_event, details) => log('child-process-gone', {
    type: details.type, reason: details.reason, exitCode: details.exitCode,
  }));

  app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents;
    const windowId = window.id;
    const report = (event, details = {}) => log(event, { windowId, ...details });
    report('window-created');
    const pending = setTimeout(() => {
      if (!contents.isDestroyed()) report('page-not-ready', {
        url: contents.getURL(), loading: contents.isLoading(),
      });
    }, 15_000);
    pending.unref();
    window.once('closed', () => clearTimeout(pending));
    window.once('ready-to-show', () => report('ready-to-show', {
      visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getBounds(),
    }));
    contents.on('did-start-loading', () => report('loading'));
    contents.on('dom-ready', () => report('dom-ready'));
    contents.on('did-finish-load', () => {
      report('page-loaded');
      // Record only shell readiness, without project source or page content.
      contents.executeJavaScript(`({
        readyState: document.readyState,
        bridgeAvailable: typeof window.keywright === 'object',
        visibleViews: Array.from(document.querySelectorAll('.view'))
          .filter(view => !view.hidden).map(view => view.id)
      })`).then((state) => {
        clearTimeout(pending);
        report('page-state', state);
      }).catch((error) => {
        clearTimeout(pending);
        report('page-state-error', { message: error.message });
      });
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) clearTimeout(pending);
      report('load-failed', { code, description, url, isMainFrame });
    });
    contents.on('preload-error', (_event, preload, error) =>
      report('preload-error', { preload, message: error.message, stack: error.stack }));
    contents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning') report('renderer-console', {
        level: details.level, message: details.message,
        source: details.sourceId, line: details.lineNumber,
      });
    });
    contents.on('render-process-gone', (_event, details) => {
      clearTimeout(pending);
      report('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    });
    contents.on('unresponsive', () => report('unresponsive'));
    contents.on('responsive', () => report('responsive'));
  });
}

module.exports = { installStartupDiagnostics };
