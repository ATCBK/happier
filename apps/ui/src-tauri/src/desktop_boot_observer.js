;(function () {
  const state = { documentStart: true, readyState: document.readyState, phase: 'document-start', events: [] };
  const redact = value => String(value)
    .replace(/(?:https?|wss?|tauri|ipc):\/\/[^\s"'<>]+/g, '[address omitted]')
    .replace(/\b(?:[a-z0-9-]+\.)*localhost(?::\d+)?\b/gi, '[host omitted]');
  const record = (kind, value) => state.events.push({ kind, value: redact(value), at: performance.now() });
  state.setPhase = phase => { state.phase = phase; record('phase', phase); };
  window.__HAPPIER_DESKTOP_BOOT_OBSERVER__ = state;
  window.addEventListener('error', event => {
    record('error', event.error instanceof Error ? event.error.stack || event.error.message
      : event.message || (event.target?.tagName ? 'resource:' + event.target.tagName : 'unknown'));
    if (event.filename) {
      try { record('error-location', new URL(event.filename).pathname + ':' + event.lineno + ':' + event.colno); } catch {}
    }
    if (event.target?.src) {
      try { record('resource-path', new URL(event.target.src).pathname); } catch {}
    }
  }, true);
  window.addEventListener('unhandledrejection', event => {
    record('unhandledrejection', event.reason instanceof Error ? event.reason.stack || event.reason.message : typeof event.reason);
  });
  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = function (...args) {
      record('console.' + level, args.map(value => value instanceof Error ? value.stack || value.message : typeof value === 'string' ? value : typeof value).join(' '));
      return original.apply(this, args);
    };
  }
  document.addEventListener('readystatechange', () => {
    state.readyState = document.readyState;
    record('document', document.readyState);
  });
})();
