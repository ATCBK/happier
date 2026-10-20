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

export function summarizeNetwork(requests) {
  const endpoints = new Map();
  const active = new Map();
  let duplicateCandidates = 0;
  for (const request of [...requests].sort((a, b) => a.startMs - b.startMs)) {
    const key = `${request.method} ${request.endpoint}`;
    const row = endpoints.get(key) ?? { endpoint: request.endpoint, method: request.method, count: 0, encodedBytes: 0, failed: 0, duplicateCandidates: 0 };
    row.count++;
    row.encodedBytes += request.encodedBytes ?? 0;
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
  return { requests: requests.length, duplicateCandidates,
    encodedBytes: requests.reduce((sum, request) => sum + (request.encodedBytes ?? 0), 0),
    endpoints: [...endpoints.values()].sort((a, b) => b.count - a.count) };
}

// Promoted from PERF10 profile/cpu-modules: sample-weighted self and inclusive
// attribution, with recursive frames counted once and script-scoped identity.
export function summarizeProfile(profile, symbols = new Map()) {
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
  'parentSpanId', 'method', 'rpcMethod', 'route', 'statusCode', 'status', 'stage', 'actionId', 'code', 'url']);

export function parseLogRecords(text, { date, timezoneOffsetMinutes = 0 } = {}) {
  const records = [];
  let pretty;
  const flush = () => { if (pretty) records.push(pretty); pretty = undefined; };
  const project = record => Object.fromEntries(Object.entries(record).filter(([key]) => logFields.has(key) || key === 'atMs'));
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const iso = line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+)\]/)?.[1];
    const clock = line.match(/^\[(\d\d:\d\d:\d\d(?:\.\d+)?)\]/)?.[1];
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
    if (iso && /(?:INFO|WARN|ERROR|DEBUG|FATAL):/.test(line)) {
      flush();
      pretty = { atMs: Date.parse(iso) };
      if (line.includes('[web-latency]')) pretty.module = 'web-latency';
    } else if (pretty) {
      const match = line.replace(/^\[server\] \[[^\]]+\]\s*/, '').trim().match(/^"?([\w]+)"?:\s*(.*?)(?:,)?$/);
      if (!match || !logFields.has(match[1])) continue;
      try { pretty[match[1]] = JSON.parse(match[2].replace(/,$/, '')); } catch { continue; }
      if (match[1] === 'url') pretty.url = safeUrl(pretty.url);
    }
  }
  flush();
  return records;
}

export function summarizeLogs(input, { startMs, endMs, date } = {}) {
  const records = (typeof input === 'string' ? parseLogRecords(input, { date }) : input)
    .filter(record => record.atMs >= startMs && record.atMs <= endMs);
  const queries = records.filter(record => record.role !== 'daemon' && record.module === 'web-latency' && record.phase?.startsWith('db.'));
  const http = records.filter(record => record.role !== 'daemon' && record.module === 'web-latency' && record.phase?.startsWith('http.'))
    .map(record => ({ ...record, dbAttempts: queries.filter(query => query.requestId && query.requestId === record.requestId).length }));
  return { records, http, db: { attempts: queries.length, correlated: queries.filter(query => Boolean(query.requestId)).length },
    daemon: records.filter(record => ['daemon-control', 'external-action-stage'].includes(record.module)) };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function compareRuns(before, after) {
  const key = run => JSON.stringify([run.journey, run.cache, run.uiMode]);
  return [...new Set([...before, ...after].map(key))].map(group => {
    const left = before.filter(run => key(run) === group);
    const right = after.filter(run => key(run) === group);
    const mean = (runs, metric) => runs.length && runs.every(run => typeof run.counts[metric] === 'number')
      ? runs.reduce((sum, run) => sum + run.counts[metric], 0) / runs.length : null;
    const metrics = new Set([...left, ...right].flatMap(run => Object.keys(run.counts)));
    const timing = runs => runs.length >= 5 && runs.every(run => run.uiMode === 'export' && run.status !== 'INCOMPLETE')
      ? { p50Ms: percentile(runs.map(run => run.durationMs), .5), p95Ms: percentile(runs.map(run => run.durationMs), .95) } : null;
    return { journey: JSON.parse(group)[0], cache: JSON.parse(group)[1], uiMode: JSON.parse(group)[2],
      beforeRuns: left.length, afterRuns: right.length, beforeTiming: timing(left), afterTiming: timing(right),
      counts: Object.fromEntries([...metrics].map(metric => {
        const a = mean(left, metric), b = mean(right, metric);
        return [metric, { before: a, after: b, delta: a === null || b === null ? null : b - a }];
      })) };
  });
}
