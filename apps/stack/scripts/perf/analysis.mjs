import { createHash } from 'node:crypto';
// This checkout-only diagnostic tool consumes the current source owner. Node
// 22.18+ strips this syntax-only TS module; no workspace dist publication needed.
import { redactPublicShareCapabilityUrl } from '../../../../packages/protocol/src/crypto/publicShareCapabilityUrl.ts';

// Use the protocol's capability-path owner. Headers, bodies, queries and fragments
// never enter artifacts; a per-run salted digest retains duplicate identity.
export function safeUrl(raw) {
  if (!raw) return '';
  if (/^happier-plugin-ui-[a-zA-Z0-9._/-]+$/.test(raw)) return raw;
  if (!/^(?:https?:|file:|\/)/.test(raw)) return raw.startsWith('data:') ? 'data:[omitted]' : '[non-url]';
  const url = new URL(raw, 'http://relative.invalid');
  return (url.origin === 'http://relative.invalid' ? '' : url.origin) + redactPublicShareCapabilityUrl(url.pathname);
}

export function requestFingerprint(request, salt) {
  return createHash('sha256').update(salt).update(JSON.stringify([
    request.method, request.url, request.postData ?? '', request.hasPostData ?? false,
  ])).digest('hex');
}

export function networkRouteClass(endpoint, method = 'GET') {
  const path = new URL(endpoint, 'http://relative.invalid').pathname;
  if (/^\/v[12]\/sessions\/[^/]+$/.test(path)) {
    const segment = path.split('/').at(-1);
    // Fixed siblings registered by the current Session route owners, not rows.
    if (['active', 'metadata-upgrades', 'archived', 'lookup-by-tags', 'access-candidates', 'access-grants',
      'access-context', 'query', 'responsibility', 'read-batch'].includes(segment)) return 'session-fixed-route';
    return method === 'GET' ? 'session-exact' : 'other';
  }
  if (method === 'GET' && /^\/v1\/machines\/[^/]+$/.test(path)) return 'machine-exact';
  return 'other';
}

export function summarizeNetwork(input, { startMs = -Infinity, endMs = Infinity } = {}) {
  const requests = input.filter(request => request.startMs >= startMs && request.startMs <= endMs);
  const endpoints = new Map();
  const active = new Map();
  const dispositions = { completed: 0, failed: 0, canceled: 0, pendingAtEnd: 0, completedAfterWindow: 0 };
  const routeClasses = {};
  let duplicateCandidates = 0;
  for (const request of [...requests].sort((a, b) => a.startMs - b.startMs)) {
    const routeClass = networkRouteClass(request.endpoint, request.method);
    routeClasses[routeClass] = (routeClasses[routeClass] ?? 0) + 1;
    if (request.endMs === undefined || request.endMs > endMs) dispositions.pendingAtEnd++;
    else if (request.canceled) dispositions.canceled++;
    else if (request.failed) dispositions.failed++;
    else dispositions.completed++;
    if (request.endMs > endMs) dispositions.completedAfterWindow++;
    const key = `${request.method} ${request.endpoint}`;
    const row = endpoints.get(key) ?? { endpoint: request.endpoint, method: request.method, count: 0, encodedBytes: 0, failed: 0, duplicateCandidates: 0 };
    row.count++;
    row.encodedBytes += request.endMs <= endMs ? request.encodedBytes ?? 0 : 0;
    row.failed += Number(Boolean(request.failed));
    // Missing POST bodies cannot establish request equality. CDP can omit large
    // or multipart bodies; do not call these duplicates from the URL alone.
    if (request.fingerprint && !request.bodyUnknown) {
      const identity = `${request.method} ${request.fingerprint}`;
      if ((active.get(identity) ?? -Infinity) > request.startMs) {
        row.duplicateCandidates++;
        duplicateCandidates++;
      }
      active.set(identity, Math.max(active.get(identity) ?? -Infinity, request.endMs ?? Infinity));
    }
    endpoints.set(key, row);
  }
  const completed = requests.filter(request => request.endMs <= endMs);
  const encodedBytesCompletedWithinWindow = completed.reduce((sum, request) => sum + (request.encodedBytes ?? 0), 0);
  const decodedBytes = completed.every(request => Number.isFinite(request.decodedBytes) && request.decodedBytes >= 0)
    ? completed.reduce((sum, request) => sum + request.decodedBytes, 0) : null;
  return { requests: requests.length, duplicateCandidates, dispositions, routeClasses,
    encodedBytes: encodedBytesCompletedWithinWindow, encodedBytesCompletedWithinWindow, decodedBytes,
    encodedBytesObserved: requests.reduce((sum, request) => sum + (request.encodedBytes ?? 0), 0),
    endpoints: [...endpoints.values()].sort((a, b) => b.count - a.count) };
}

// Promoted from PERF10 profile/cpu-modules: sample-weighted self and inclusive
// attribution, with recursive frames counted once and script-scoped identity.
export function normalizeProfileSamples(profile) {
  // Tracing and Profiler together can deliver out-of-order sample timestamps
  // encoded as signed deltas. Clamping each incoming delta double-counts time.
  // Reconstruct first, sort, then clip; retain the original profile as evidence.
  let timestamp = profile.startTime;
  const entries = (profile.samples ?? []).map((id, index) => {
    const delta = profile.timeDeltas?.[index];
    if (!Number.isFinite(delta)) throw new TypeError('CPU profile sample delta is unavailable');
    timestamp += delta;
    return { id, timestamp };
  }).sort((a, b) => a.timestamp - b.timestamp);
  let previous = profile.startTime;
  const timeDeltas = entries.map(entry => {
    const end = Math.max(profile.startTime, Math.min(profile.endTime, entry.timestamp));
    const delta = end - previous;
    previous = end;
    return delta;
  });
  return { ...profile, samples: entries.map(entry => entry.id), timeDeltas };
}

export function summarizeProfile(profile, symbols = new Map()) {
  profile = normalizeProfileSamples(profile);
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const functions = new Map();
  const modules = new Map();
  const fact = id => {
    const frame = nodes.get(id).callFrame;
    const mapped = symbols.get(frameKey(frame));
    const source = mapped?.source ?? safeUrl(frame.url);
    const name = mapped?.name ?? frame.functionName;
    const line = mapped?.line ?? frame.lineNumber;
    const key = JSON.stringify([frame.scriptId, source, name, line, mapped?.column ?? frame.columnNumber]);
    if (!functions.has(key)) functions.set(key, { source, name, line, scriptId: frame.scriptId, mapped: Boolean(mapped), selfMs: 0, inclusiveMs: 0 });
    return { key, row: functions.get(key) };
  };
  let sampledMs = 0;
  for (let index = 0; index < (profile.samples ?? []).length; index++) {
    const ms = profile.timeDeltas[index] / 1000;
    const id = profile.samples[index];
    const leaf = fact(id);
    sampledMs += ms;
    leaf.row.selfMs += ms;
    modules.set(leaf.row.source, (modules.get(leaf.row.source) ?? 0) + ms);
    const seen = new Set();
    for (let current = id; current !== undefined; current = parents.get(current)) {
      const { key, row } = fact(current);
      if (!seen.has(key)) { row.inclusiveMs += ms; seen.add(key); }
    }
  }
  return { wallMs: (profile.endTime - profile.startTime) / 1000, sampledMs,
    modules: [...modules].map(([source, selfMs]) => ({ source, selfMs })).sort((a, b) => b.selfMs - a.selfMs),
    functions: [...functions.values()].sort((a, b) => b.selfMs - a.selfMs) };
}

export const frameKey = frame => JSON.stringify([frame.scriptId, frame.url, frame.lineNumber, frame.columnNumber, frame.functionName]);

const logFields = new Set(['phase', 'module', 'elapsedMs', 'durationMs', 'responseTime', 'requestId', 'reqId', 'spanId',
  'parentSpanId', 'method', 'rpcMethod', 'route', 'statusCode', 'status', 'stage', 'actionId', 'code', 'url',
  'transactionClass', 'sqlState']);

const stripLogPrefix = raw => raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[server\]\s*\[[^\]]+\]\s*/, '');
export const isLogRecordStart = raw => {
  const line = stripLogPrefix(raw);
  return /^\{.*"(?:time|timestamp)"\s*:/.test(line) || /^\[\d\d:\d\d:/.test(line)
    || /\[\d{4}-\d\d-\d\dT[^\]]+\].*\b(?:INFO|WARN|ERROR|DEBUG|FATAL)(?:\([^)]*\))?:/.test(raw);
};

const projectLogField = (key, value) => {
  if (!logFields.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (key === 'url' || key === 'route') return typeof value === 'string' ? safeUrl(value) : undefined;
  return value;
};

export function parseLogRecords(text, { date, timezoneOffsetMinutes = 0 } = {}) {
  const records = [];
  let pretty;
  const flush = () => { if (pretty) records.push(pretty); pretty = undefined; };
  const project = record => Object.fromEntries(Object.entries(record).flatMap(([key, value]) => {
    const safe = key === 'atMs' ? value : projectLogField(key, value);
    return safe === undefined ? [] : [[key, safe]];
  }));
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const iso = line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+)\]/)?.[1];
    const clock = stripLogPrefix(line).match(/^\[(\d\d:\d\d:\d\d(?:\.\d+)?)\]/)?.[1];
    const brace = line.indexOf('{');
    if (brace >= 0) {
      try {
        const event = JSON.parse(line.slice(brace));
        const time = event.time ?? event.timestamp ?? iso ?? (date && clock ? `${date}T${clock}Z` : undefined);
        const atMs = typeof time === 'number' ? time : Date.parse(time) + (event.time === undefined && !event.timestamp && !iso && clock ? timezoneOffsetMinutes * 60000 : 0);
        if (Number.isFinite(atMs)) {
          flush();
          const record = project({ ...event, atMs });
          if (line.includes('[web-latency]')) record.module = 'web-latency';
          if (line.includes('[CONTROL SERVER]')) record.module = 'daemon-control';
          if (line.includes('[external-action-stage]')) record.module = 'external-action-stage';
          if (record.url) record.url = safeUrl(record.url);
          records.push(record);
          continue;
        }
      } catch { /* A pretty-printed object's opening brace is handled below. */ }
    }
    if ((iso || date && clock) && /(?:INFO|WARN|ERROR|DEBUG|FATAL)(?:\([^)]*\))?:/.test(line)) {
      flush();
      // pino-pretty's canonical messageFormat retains the numeric emitter time.
      // The Stack prefix is a later tee receipt, sometimes delayed under load.
      const emittedAt = line.match(/\|\s*\[(\d+)\]\s*$/)?.[1];
      pretty = { atMs: emittedAt ? Number(emittedAt) : iso ? Date.parse(iso) : Date.parse(`${date}T${clock}Z`) + timezoneOffsetMinutes * 60000 };
      if (line.includes('[web-latency]')) pretty.module = 'web-latency';
    } else if (pretty) {
      const match = line.replace(/^\[server\] \[[^\]]+\]\s*/, '').trim().match(/^"?([\w]+)"?:\s*(.*?)(?:,)?$/);
      if (!match || !logFields.has(match[1])) continue;
      try {
        const value = projectLogField(match[1], JSON.parse(match[2].replace(/,$/, '')));
        if (value !== undefined) pretty[match[1]] = value;
      } catch { continue; }
    }
  }
  flush();
  return records;
}

export function summarizeLogs(input, { startMs, endMs, date } = {}) {
  const records = (typeof input === 'string' ? parseLogRecords(input, { date }) : input)
    .filter(record => record.atMs >= startMs && record.atMs <= endMs);
  const dbPhases = records.filter(record => record.role !== 'daemon' && record.module === 'web-latency' && record.phase?.startsWith('db.'));
  const isTransactionPhase = record => record.phase === 'db.transaction' || record.phase.startsWith('db.transaction.');
  const transactions = dbPhases.filter(isTransactionPhase);
  const queries = dbPhases.filter(record => !isTransactionPhase(record));
  const byRequest = new Map();
  for (const record of dbPhases) if (record.requestId) {
    const row = byRequest.get(record.requestId) ?? { dbAttempts: 0, transactionPhases: 0 };
    if (isTransactionPhase(record)) row.transactionPhases++;
    else row.dbAttempts++;
    byRequest.set(record.requestId, row);
  }
  const http = records.filter(record => record.role !== 'daemon' && record.module === 'web-latency' && record.phase?.startsWith('http.'))
    .map(record => ({ ...record, ...(byRequest.get(record.requestId) ?? { dbAttempts: 0, transactionPhases: 0 }) }));
  return { records, http, db: { phaseRecords: dbPhases.length, transactionPhaseRecords: transactions.length,
    attempts: queries.length, correlated: queries.filter(query => Boolean(query.requestId)).length },
    daemon: records.filter(record => ['daemon-control', 'external-action-stage'].includes(record.module)) };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export const backendProfileRolesForRun = run => [...new Set(run.backendProfileRoles ?? [])].sort();

export function isUnperturbedTimingRun(run) {
  return run.uiMode === 'export' && run.status === 'CAPTURED' && run.captureMode === 'timing'
    && run.instrumentation?.profiling !== true && backendProfileRolesForRun(run).length === 0
    && run.instrumentation?.storeTelemetry === false && run.instrumentation?.fiberHook === false;
}

export function compareRuns(before, after) {
  before = before.filter(run => run.status !== 'FAILED' && run.eligible !== false);
  after = after.filter(run => run.status !== 'FAILED' && run.eligible !== false);
  const key = run => JSON.stringify([run.journey, run.cache, run.uiMode, run.captureMode ?? 'unknown', run.version ?? 'legacy-unknown', run.instrumentation?.profiling === true, backendProfileRolesForRun(run)]);
  return [...new Set([...before, ...after].map(key))].map(group => {
    const left = before.filter(run => key(run) === group);
    const right = after.filter(run => key(run) === group);
    const mean = (runs, metric) => runs.length && runs.every(run => typeof run.counts[metric] === 'number')
      ? runs.reduce((sum, run) => sum + run.counts[metric], 0) / runs.length : null;
    const metrics = new Set([...left, ...right].flatMap(run => Object.keys(run.counts)));
    const timing = runs => runs.length >= 5 && runs.every(isUnperturbedTimingRun)
      ? { p50Ms: percentile(runs.map(run => run.durationMs), .5), p95Ms: percentile(runs.map(run => run.durationMs), .95) } : null;
    const [journey, cache, uiMode, captureMode, version, profiling, backendProfileRoles] = JSON.parse(group);
    return { journey, cache, uiMode, captureMode, version, profiling, backendProfileRoles,
      beforeRuns: left.length, afterRuns: right.length, beforeTiming: timing(left), afterTiming: timing(right),
      counts: Object.fromEntries([...metrics].map(metric => {
        const a = mean(left, metric), b = mean(right, metric);
        return [metric, { before: a, after: b, delta: a === null || b === null ? null : b - a }];
      })) };
  });
}
