import { frameKey, safeUrl } from './analysis.mjs';

function unionDuration(intervals) {
  let total = 0, end = -Infinity;
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}

const taskName = /^(?:RunTask|ThreadControllerImpl::RunTask|MessageLoop::RunTask|ThreadPool_RunTask)$/;
const renderingName = /^(?:UpdateLayoutTree|RecalculateStyles|Layout|PrePaint|Paint|PaintImage|CompositeLayers|Layerize|UpdateLayerTree)$/;
const gcName = /(?:^|[.:_])(?:MajorGC|MinorGC|GC|GarbageCollect)(?:$|[.:_])/;
const traceLimitations = [
  'Busy time is the union of main-thread task envelopes; it includes diagnostic instrumentation overhead.',
  'Trigger labels describe nested trace events, not proven remote-change causality. Store keys and socket packets alone do not establish semantic changes.',
  'Style/layout/paint and GC are separately unioned categories and may overlap task or trigger totals.',
];

function mainThreadSpans(events, { startUs, endUs, pid, tid }) {
  const spans = [], stack = [];
  let incomplete = false;
  const append = (event, end) => spans.push({ name: event.name, data: event.args?.data,
    eventType: event.args?.data?.type, originalStart: event.ts, originalEnd: end,
    start: event.ts, end });
  for (const event of events.filter(event => event.pid === pid && event.tid === tid && Number.isFinite(event.ts))
    .sort((a, b) => a.ts - b.ts)) {
    if (event.ph === 'B') stack.push(event);
    else if (event.ph === 'E') {
      const begin = stack.pop();
      if (begin) append(begin, event.ts);
      else if (event.ts >= startUs && event.ts <= endUs) incomplete = true;
    } else if (event.ph === 'X' && Number.isFinite(event.dur) && event.dur >= 0) append(event, event.ts + event.dur);
  }
  if (stack.some(event => event.ts < endUs)) incomplete = true;
  return { incomplete, clipped: spans.filter(span => span.end > startUs && span.start < endUs)
    .map(span => ({ ...span, originalDuration: span.end - span.start,
      start: Math.max(startUs, span.start), end: Math.min(endUs, span.end) }))
    .sort((a, b) => a.start - b.start || b.end - a.end) };
}

function taskEnvelopes(spans) {
  const tasks = [];
  for (const span of spans.filter(span => taskName.test(span.name))) {
    // Nested RunTask records describe the same occupied thread interval.
    if (tasks.length && span.start >= tasks.at(-1).start && span.end <= tasks.at(-1).end) continue;
    tasks.push({ ...span, trigger: 'unattributed', priority: Infinity });
  }
  return tasks;
}

export function summarizeMainThreadTrace(events, { startUs, endUs, pid, tid } = {}) {
  const durationMs = (endUs - startUs) / 1000;
  const empty = { available: false, startUs, endUs, pid, tid, durationMs,
    mainThreadBusyMs: null, busyFraction: null, taskCount: null, longTaskCount: null,
    maxTaskMs: null, styleLayoutPaintMs: null, gcMs: null, triggerRows: [], limitations: traceLimitations };
  if (!Array.isArray(events) || !Number.isFinite(startUs) || !Number.isFinite(endUs)
    || endUs <= startUs || pid === undefined || tid === undefined) return { ...empty, unavailableReason: 'explicit-thread-window-required' };
  const { clipped, incomplete } = mainThreadSpans(events, { startUs, endUs, pid, tid });
  const tasks = taskEnvelopes(clipped);
  if (incomplete || !tasks.length) return { ...empty,
    unavailableReason: incomplete ? 'incomplete-thread-events' : 'task-envelopes-unavailable' };
  let taskIndex = 0;
  for (const span of clipped) {
    while (taskIndex < tasks.length && tasks[taskIndex].end <= span.start) taskIndex++;
    const task = tasks[taskIndex];
    if (!task || span.start < task.start) continue;
    const trigger = span.name === 'EventDispatch'
      ? [/^(?:click|dblclick|contextmenu|pointerdown|pointerup|pointermove|mousedown|mouseup|mousemove|keydown|keyup|keypress|touchstart|touchend|touchmove|wheel|input|change|submit)$/.test(span.eventType) ? 'user-event' : 'event', 0]
      : /^WebSocket/.test(span.name) ? ['socket', 1]
      : span.name === 'TimerFire' ? ['timer', 2]
      : span.name === 'FireAnimationFrame' ? ['animation-frame', 3]
      : span.name === 'RunMicrotasks' ? ['microtask', 4] : null;
    if (trigger && trigger[1] < task.priority) [task.trigger, task.priority] = trigger;
  }
  const triggers = new Map();
  for (const task of tasks) {
    const row = triggers.get(task.trigger) ?? { trigger: task.trigger, intervals: [], taskCount: 0, longTaskCount: 0 };
    row.intervals.push(task); row.taskCount++; row.longTaskCount += Number(task.originalDuration > 50000);
    triggers.set(task.trigger, row);
  }
  const mainThreadBusyMs = unionDuration(tasks) / 1000;
  return { available: true, startUs, endUs, pid, tid, durationMs, mainThreadBusyMs,
    busyFraction: mainThreadBusyMs / durationMs, taskCount: tasks.length,
    longTaskCount: tasks.filter(task => task.originalDuration > 50000).length,
    maxTaskMs: tasks.reduce((maximum, task) => Math.max(maximum, (task.end - task.start) / 1000), 0),
    styleLayoutPaintMs: unionDuration(clipped.filter(span => renderingName.test(span.name))) / 1000,
    gcMs: unionDuration(clipped.filter(span => gcName.test(span.name))) / 1000,
    triggerRows: [...triggers.values()].map(({ intervals, ...row }) => ({ ...row, ms: unionDuration(intervals) / 1000 }))
      .sort((a, b) => b.ms - a.ms), limitations: traceLimitations };
}

// Sources are proven generated locations from the loaded Metro factory, or a
// direct module URL. A cadence/name/neighboring task is never ownership proof.
export function summarizeJsThreadLagSampler(events, window, sources = []) {
  const observed = summarizeMainThreadTrace(events, window);
  const limitations = [
    'Only proven direct TimerFire callback slices are subtracted; enclosing task overhead remains.',
    'This is observed slice arithmetic, not a sampler-off counterfactual: induced GC elsewhere, displaced work and other diagnostic overhead remain.',
    'Residual long-task durations subtract in-window overlap from original envelopes; they are not newly observed continuous tasks.',
    'Raw J13 acceptance uses the unmodified trace summary, never this residual.',
  ];
  const unavailable = reason => ({ available: false, unavailableReason: reason, counterfactual: false, observed, limitations });
  if (!observed.available) return unavailable(observed.unavailableReason);
  const { clipped } = mainThreadSpans(events, window);
  const calls = clipped.filter(span => span.name === 'FunctionCall')
    .sort((a, b) => a.originalStart - b.originalStart || b.originalEnd - a.originalEnd);
  if (!calls.length) return unavailable('function-call-trace-unavailable');
  const directUrl = data => /(?:^|\/)jsThreadLagTelemetry\.[jt]s(?:[?#]|$)/.test(data?.url ?? '');
  const ranges = sources.filter(source => typeof source.scriptId === 'string'
    && Number.isInteger(source.startLine) && Number.isInteger(source.endLine) && source.endLine > source.startLine);
  if (!ranges.length && !calls.some(call => directUrl(call.data))) return unavailable('sampler-source-proof-unavailable');
  const owned = clipped.filter(span => span.name === 'TimerFire').filter(timer => {
    let low = 0, high = calls.length;
    while (low < high) { const mid = (low + high) >>> 1;
      if (calls[mid].originalStart < timer.originalStart) low = mid + 1; else high = mid;
    }
    // The first contained FunctionCall is the timer's direct callback, not an
    // arbitrary nested invocation of a sampler helper in some other callback.
    let first;
    for (let index = low; index < calls.length && calls[index].originalStart < timer.originalEnd; index++) {
      if (calls[index].originalEnd <= timer.originalEnd) { first = calls[index]; break; }
    }
    const data = first?.data;
    return directUrl(data) || ranges.some(source => data?.scriptId === source.scriptId
      && data.lineNumber >= source.startLine && data.lineNumber < source.endLine);
  });
  const merged = [];
  for (const span of owned) {
    if (merged.length && span.start <= merged.at(-1).end) merged.at(-1).end = Math.max(merged.at(-1).end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  const intersections = span => {
    const rows = [];
    let low = 0, high = merged.length;
    while (low < high) { const mid = (low + high) >>> 1;
      if (merged[mid].end <= span.start) low = mid + 1; else high = mid;
    }
    for (let index = low; index < merged.length && merged[index].start < span.end; index++) {
      rows.push({ start: Math.max(span.start, merged[index].start), end: Math.min(span.end, merged[index].end) });
    }
    return rows;
  };
  const overlap = span => unionDuration(intersections(span));
  const tasks = taskEnvelopes(clipped), gc = clipped.filter(span => gcName.test(span.name));
  // Intersection of overlapping GC/task intervals is unioned as well.
  const intersected = spans => unionDuration(spans.flatMap(intersections));
  const taskOverlapMs = intersected(tasks) / 1000, gcInsideSamplerMs = intersected(gc) / 1000;
  const mainThreadBusyMs = observed.mainThreadBusyMs - taskOverlapMs;
  return { available: true, counterfactual: false, observed, timerFireCount: owned.length,
    timerSliceMs: unionDuration(merged) / 1000, taskOverlapMs, gcInsideSamplerMs,
    withoutSamplerSlices: { mainThreadBusyMs, busyFraction: mainThreadBusyMs / observed.durationMs,
      longTaskCount: tasks.filter(task => task.originalDuration - overlap(task) > 50000).length,
      maxTaskMs: tasks.reduce((maximum, task) => Math.max(maximum, (task.end - task.start - overlap(task)) / 1000), 0),
      gcMs: observed.gcMs - gcInsideSamplerMs }, limitations };
}

export function summarizeHeapProfile(profile, symbols = new Map()) {
  const limitations = ['CDP sampling profile allocation estimates are not retained heap or a dominator analysis.'];
  if (!profile?.head) return { available: false, sampledBytes: null, functions: [], limitations };
  const functions = new Map(), pending = [profile.head];
  let sampledBytes = 0;
  while (pending.length) {
    const node = pending.pop();
    for (const child of node.children ?? []) pending.push(child);
    const bytes = node.selfSize;
    if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError('Sampling heap profile selfSize is invalid');
    const frame = node.callFrame, mapped = symbols.get(frameKey(frame));
    const source = mapped?.source
      ? (/^(?:https?:|file:|\/|data:)/.test(mapped.source) ? safeUrl(mapped.source) : mapped.source.split(/[?#]/)[0])
      : safeUrl(frame.url);
    const name = mapped?.name ?? frame.functionName, line = mapped?.line ?? frame.lineNumber;
    const key = JSON.stringify([source, name, line]);
    const row = functions.get(key) ?? { source, name, line, selfBytes: 0 };
    row.selfBytes += bytes; sampledBytes += bytes; functions.set(key, row);
  }
  return { available: true, sampledBytes, sampleCount: profile.samples?.length ?? null,
    functions: [...functions.values()].sort((a, b) => b.selfBytes - a.selfBytes), limitations };
}

export function evaluateSettledHome({ trace, diagnostics, durationMs } = {}, definition = {}) {
  const minDurationMs = Math.max(300000, definition.minDurationMs ?? 300000);
  const maxBusyFraction = Math.min(.05, definition.maxBusyFraction ?? .05);
  if (!Number.isFinite(minDurationMs) || !Number.isFinite(maxBusyFraction) || maxBusyFraction <= 0) {
    throw new TypeError('Settled Home assertion definition is invalid');
  }
  const failures = [], unavailable = [];
  if (!Number.isFinite(durationMs)) unavailable.push('capture-duration-unavailable');
  else if (durationMs < minDurationMs) failures.push('capture-shorter-than-five-minutes');
  if (trace?.available !== true || trace.dataLossOccurred === true) unavailable.push('complete-main-thread-trace-unavailable');
  else {
    if (!Number.isFinite(trace.durationMs)) unavailable.push('trace-duration-unavailable');
    else if (trace.durationMs < minDurationMs) failures.push('trace-shorter-than-five-minutes');
    if (!Number.isFinite(trace.busyFraction) || trace.busyFraction < 0 || trace.busyFraction > 1) unavailable.push('main-thread-busy-unavailable');
    else if (trace.busyFraction >= maxBusyFraction) failures.push('main-thread-busy-at-or-above-budget');
    if (!Number.isInteger(trace.longTaskCount) || trace.longTaskCount < 0) unavailable.push('long-task-count-unavailable');
    else if (trace.longTaskCount > 0) failures.push('long-tasks-observed');
  }
  let emptyChangedKeyNotifications = null, nonemptyChangedKeyNotifications = null;
  const notifications = diagnostics?.storeNotifications;
  if (diagnostics?.storeNotificationsAvailable !== true || !Array.isArray(notifications)) unavailable.push('store-key-observer-unavailable');
  else if (notifications.some(row => !Array.isArray(row.changedKeys) || row.changedKeys.some(key => typeof key !== 'string'))) {
    unavailable.push('store-notification-keys-unavailable');
  } else {
    emptyChangedKeyNotifications = notifications.filter(row => row.changedKeys.length === 0).length;
    nonemptyChangedKeyNotifications = notifications.length - emptyChangedKeyNotifications;
    if (emptyChangedKeyNotifications > 0) failures.push('empty-changed-key-notifications');
  }
  return { status: unavailable.length ? 'UNAVAILABLE' : failures.length ? 'FAIL' : 'PASS', failures, unavailable,
    metrics: { durationMs, busyFraction: trace?.busyFraction ?? null, longTaskCount: trace?.longTaskCount ?? null,
      storeNotifications: Array.isArray(notifications) ? notifications.length : null,
      emptyChangedKeyNotifications, nonemptyChangedKeyNotifications, semanticChangesVerified: false },
    thresholds: { minDurationMs, maxBusyFractionExclusive: maxBusyFraction, maxLongTasks: 0, maxEmptyChangedKeyNotifications: 0 },
    limitations: [
      'This conservative gate requires zero long tasks; no causal exemption is inferred from socket traffic or changed references.',
      'Nonempty changed-key notifications observe identity changes only. Real semantic data changes and polling consumer intent are not verified.',
      'Heavy profiling changes runtime cost; this result is diagnostic attribution, not production timing certification.',
    ] };
}
