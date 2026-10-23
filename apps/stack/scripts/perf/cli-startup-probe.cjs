// Development-only process-boundary instrumentation. Never records file bodies,
// credentials, request headers, payloads, or query strings.
const fs = require('node:fs');
const Module = require('node:module');
const net = require('node:net');
const http = require('node:http');
const dns = require('node:dns');
const { channel } = require('node:diagnostics_channel');
const { syncBuiltinESMExports } = require('node:module');
const { performance } = require('node:perf_hooks');
const output = process.env.CLISTART_TRACE;
const events = [{ kind: 'preload', ms: performance.now(), pid: process.pid }];
const loads = [];
const resolutions = [];
let coverageSession;
let coverageAtFirstRequest;
function takeCoverage() {
  let coverage = [];
  coverageSession?.post('Profiler.takePreciseCoverage', (error, result) => {
    if (error) mark('coverage:error', { message: error.message });
    else coverage = result.result;
  });
  return coverage;
}
const write = fs.writeFileSync.bind(fs);
const mark = (kind, data = {}) => events.push({ kind, ms: performance.now(), ...data });
const originalLoad = Module._load;
Module._load = function (id, parent, ...args) {
  const start = performance.now();
  try { return originalLoad.call(this, id, parent, ...args); }
  finally {
    loads.push({ id, parent: parent?.filename, start, end: performance.now() });
  }
};
for (const name of ['readFileSync', 'existsSync', 'statSync', 'accessSync']) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    const tracked = String(path).startsWith(process.env.HAPPIER_HOME_DIR ?? '\0');
    if (tracked) mark(name, { path: String(path) });
    try { return original.call(this, path, ...args); }
    finally { if (tracked) mark(`${name}:end`, { path: String(path) }); }
  };
}
for (const name of ['readFile', 'stat', 'access']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (path, ...args) {
    const tracked = String(path).startsWith(process.env.HAPPIER_HOME_DIR ?? '\0');
    if (tracked) mark(`${name}:start`, { path: String(path) });
    try { return await original.call(this, path, ...args); }
    finally { if (tracked) mark(`${name}:end`, { path: String(path) }); }
  };
}
const connect = net.Socket.prototype.connect;
const lookup = dns.lookup;
dns.lookup = function (...args) {
  mark('dns:lookup');
  const last = args.length - 1;
  if (typeof args[last] === 'function') {
    const callback = args[last];
    args[last] = function (...result) {
      mark('dns:lookup:end');
      return callback.apply(this, result);
    };
  }
  return lookup.apply(this, args);
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (...args) {
  mark('dns:lookup');
  try { return await promiseLookup.apply(this, args); }
  finally { mark('dns:lookup:end'); }
};
net.Socket.prototype.connect = function (...args) {
  // Node also uses this adapter for Unix/Windows named-pipe IPC (not a network
  // request). tsx's source-loader IPC belongs to the development harness.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipc = (options && typeof options === 'object' && typeof options.path === 'string')
    || (typeof options === 'string' && !/^\d+$/u.test(options.trim()));
  const transport = ipc ? 'ipc' : 'tcp';
  mark('socket:start', { transport });
  this.once('connect', () => mark('socket:connected', { transport }));
  return connect.apply(this, args);
};
const request = http.request;
// Fetch uses Undici rather than node:http. Observe its existing request event
// without touching global fetch (whose lazy getter would load it for help).
channel('undici:request:create').subscribe(({ request }) => {
  mark('http:request', { path: typeof request?.path === 'string' ? request.path.split('?')[0] : null,
    source: 'undici', clockUs: Number(process.hrtime.bigint() / 1000n) });
  if (coverageSession && coverageAtFirstRequest === undefined) coverageAtFirstRequest = takeCoverage();
});
http.request = function (...args) {
  const url = typeof args[0] === 'string' ? new URL(args[0]) : args[0];
  mark('http:request', { path: url?.pathname ?? url?.path?.split('?')[0] ?? null,
    clockUs: Number(process.hrtime.bigint() / 1000n) });
  if (coverageSession && coverageAtFirstRequest === undefined) coverageAtFirstRequest = takeCoverage();
  return request.apply(this, args);
};
syncBuiltinESMExports();
if (process.env.CLISTART_IMPORT_TRACE === '1') {
  if (typeof Module.registerHooks === 'function') Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const start = performance.now();
      const result = nextResolve(specifier, context);
      resolutions.push({ specifier, parent: context.parentURL, url: result.url, start, end: performance.now() });
      return result;
    },
    load(url, context, nextLoad) {
      const start = performance.now();
      const result = nextLoad(url, context);
      mark('module:loaded', { url, start });
      return result;
    },
  });
  const { Session } = require('node:inspector');
  const session = new Session();
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => {
    if (params.url && !params.url.startsWith('node:')) mark('script:parsed', { url: params.url });
  });
  session.post('Debugger.enable');
  session.post('Profiler.enable');
  session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  coverageSession = session;
}
process.once('exit', code => {
  mark('exit', { code });
  // A same-thread inspector post completes synchronously, including during exit.
  // Keep coverage separate from timed runs; parsed/loaded is not evaluated.
  const coverage = takeCoverage();
  if (output) write(output, JSON.stringify({ events, loads, resolutions, coverage, coverageAtFirstRequest, modules: Object.keys(require.cache) }));
});
