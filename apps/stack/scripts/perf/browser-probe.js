// PERF10 react-hook v3's PerformedWork + alternate identity rule. Aggregate in
// the browser rather than retaining every fiber/commit or any props/state data.
(() => {
  if (globalThis.__happierPerfProbe) return;
  const tags = new Set([0, 1, 9, 11, 14, 15]);
  const current = new WeakMap();
  const name = type => typeof type === 'function' ? type.displayName || type.name || 'Anonymous'
    : type && typeof type === 'object' ? type.displayName || name(type.render || type.type) : 'Anonymous';
  const empty = () => ({ commits: 0, renders: 0, components: Object.create(null), hookMs: 0, longTasks: [] });
  let data = empty();
  const previous = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = previous ?? { supportsFiber: true, renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    checkDCE() {}, on() {}, off() {}, emit() {}, sub() { return () => {}; } };
  const commit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (...args) {
    commit?.apply(this, args);
    const started = performance.now();
    const root = args[1];
    const stack = [root.current], names = new Set();
    data.commits++;
    while (stack.length) {
      const fiber = stack.pop();
      if (tags.has(fiber.tag) && current.get(fiber) !== true && (!fiber.alternate || (fiber.flags & 1) === 1)) {
        const component = name(fiber.type);
        const row = data.components[component] ??= { renders: 0, commits: 0 };
        row.renders++;
        data.renders++;
        names.add(component);
      }
      current.set(fiber, true);
      if (fiber.alternate) current.set(fiber.alternate, false);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    for (const component of names) data.components[component].commits++;
    data.hookMs += performance.now() - started;
  };
  if (!previous) Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
  let observer;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const task of list.getEntries()) data.longTasks.push({ atMs: task.startTime, durationMs: task.duration });
    });
    observer.observe({ type: 'longtask', buffered: false });
  }
  const storageKey = 'HAPPIER_SYNC_TUNING_JSON';
  const savedKey = '__HAPPIER_PERF_TUNING_ORIGINAL__';
  let original;
  try {
    if (sessionStorage.getItem(savedKey) === null) sessionStorage.setItem(savedKey, JSON.stringify(localStorage.getItem(storageKey)));
    original = JSON.parse(sessionStorage.getItem(savedKey));
    localStorage.setItem(storageKey, JSON.stringify({ ...JSON.parse(original || '{}'), syncPerformanceTelemetryEnabled: true }));
  } catch { /* Availability is reported by the collector, never inferred. */ }
  globalThis.__happierPerfProbe = {
    reset() { data = empty(); globalThis.__HAPPIER_SYNC_PERFORMANCE__?.reset(); },
    collect() { globalThis.__HAPPIER_SYNC_PERFORMANCE__?.markScenario('perf-capture-end'); return { ...data, renderers: [...hook.renderers.values()].map(renderer => ({ version: renderer.version, package: renderer.rendererPackageName })),
      telemetryAvailable: Boolean(globalThis.__HAPPIER_SYNC_PERFORMANCE__),
      telemetry: globalThis.__HAPPIER_SYNC_PERFORMANCE__?.flush() }; },
    stop() {
      observer?.disconnect();
      hook.onCommitFiberRoot = commit;
      try { if (original === null) localStorage.removeItem(storageKey); else if (original !== undefined) localStorage.setItem(storageKey, original); sessionStorage.removeItem(savedKey); } catch {}
      delete globalThis.__happierPerfProbe;
    },
  };
})();
