import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { connectPage } from './cdp.mjs';
import { frameKey, requestFingerprint, safeUrl, summarizeNetwork, summarizeProfile } from './analysis.mjs';

function stackFrames(stack) {
  return stack ? [...(stack.callFrames ?? []).map(frame => ({ functionName: frame.functionName, url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber })),
    ...stackFrames(stack.parent)] : [];
}

export async function startCapture(options) {
  if (!['timing', 'counts'].includes(options.captureMode)) throw new Error('Explicit captureMode=timing|counts required');
  const cdp = await connectPage(options.cdp, options.pageId, options.signal);
  const salt = randomBytes(32).toString('hex');
  const requests = [], sockets = [], telemetry = [], scripts = new Map();
  const inFlight = new Map();
  let recording = false, profileStarted = false, offsetMs;
  let startMs;
  const at = timestamp => timestamp * 1000 + (offsetMs ?? 0);
  cdp.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, { url: event.url, sourceMapURL: event.sourceMapURL }));
  cdp.on('Network.requestWillBeSent', event => {
    if (!recording) return;
    offsetMs ??= event.wallTime * 1000 - event.timestamp * 1000;
    if (event.redirectResponse && inFlight.has(event.requestId)) {
      const prior = inFlight.get(event.requestId);
      prior.endMs = at(event.timestamp);
      prior.status = event.redirectResponse.status;
    }
    const row = { id: `${event.requestId}:${requests.length}`, requestId: event.requestId,
      endpoint: safeUrl(event.request.url), method: event.request.method, startMs: at(event.timestamp),
      fingerprint: requestFingerprint(event.request, salt),
      bodyUnknown: Boolean(event.request.hasPostData && !event.request.postData),
      requestBodyBytes: event.request.postData === undefined ? null : Buffer.byteLength(event.request.postData),
      initiator: { type: event.initiator.type, stack: stackFrames(event.initiator.stack) } };
    requests.push(row); inFlight.set(event.requestId, row);
  });
  cdp.on('Network.responseReceived', event => {
    const row = inFlight.get(event.requestId);
    if (!row || !recording) return;
    row.status = event.response.status;
    row.fromCache = Boolean(event.response.fromDiskCache || event.response.fromServiceWorker);
    row.mimeType = event.response.mimeType;
    const header = Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === 'x-request-id');
    if (header && /^[a-zA-Z0-9._:-]+$/.test(String(header[1]))) row.serverRequestId = header[1];
  });
  cdp.on('Network.loadingFinished', event => {
    const row = inFlight.get(event.requestId);
    if (row && recording) { row.endMs = at(event.timestamp); row.encodedBytes = event.encodedDataLength; inFlight.delete(event.requestId); }
  });
  cdp.on('Network.loadingFailed', event => {
    const row = inFlight.get(event.requestId);
    if (row && recording) { row.endMs = at(event.timestamp); row.failed = true; inFlight.delete(event.requestId); }
  });
  for (const direction of ['Sent', 'Received']) cdp.on(`Network.webSocketFrame${direction}`, event => {
    if (!recording) return;
    const { payloadData, opcode } = event.response;
    const name = opcode === 1 ? payloadData.match(/^\d*(?:-\d+)?\["([a-zA-Z0-9_.:/-]+)"/)?.[1] : undefined;
    let rpcMethod;
    // Only the method identifier leaves this boundary, never Socket.IO args.
    if (name === 'rpc-call') {
      try { const payload = JSON.parse(payloadData.slice(payloadData.indexOf('['))); const value = payload[1]?.method;
        if (typeof value === 'string' && /^[a-zA-Z0-9_.:/-]+$/.test(value)) rpcMethod = value; } catch {}
    }
    sockets.push({ atMs: at(event.timestamp), direction: direction.toLowerCase(), opcode,
      bytes: opcode === 2 ? Buffer.byteLength(payloadData, 'base64') : Buffer.byteLength(payloadData),
      event: name ?? 'protocol-or-binary', ...(rpcMethod ? { rpcMethod } : {}) });
  });
  cdp.on('Runtime.consoleAPICalled', event => {
    if (!recording) return;
    const values = event.args.map(arg => arg.value).filter(value => typeof value === 'string');
    if (!values[0]?.startsWith('[sync-perf]')) return;
    try { const summary = JSON.parse(values[1] ?? values[0].slice('[sync-perf]'.length).trim()); telemetry.push(summary); } catch {}
  });
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Browser probe evaluation failed (details suppressed)');
    return result.result.value;
  };
  try {
    for (const domain of ['Page', 'Network', 'Runtime', 'Debugger', 'Profiler', 'Performance']) await cdp.send(`${domain}.enable`);
    const { metrics } = await cdp.send('Performance.getMetrics');
    const timestamp = metrics.find(metric => metric.name === 'Timestamp')?.value;
    if (typeof timestamp === 'number') offsetMs = await evaluate('Date.now()') - timestamp * 1000;
    const probe = `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = ${JSON.stringify(options.captureMode)};\n` + await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe });
    // Install on an already loaded J13 page too, then reload through the journey
    // preparation so React sees the hook before its renderer initializes.
    await evaluate(probe);
    return { cdp, evaluate,
      async begin() {
        await evaluate('globalThis.__happierPerfProbe.reset()');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: options.cache === 'cold' });
        if (options.cache === 'cold') await cdp.send('Network.clearBrowserCache');
        startMs = Date.now(); recording = true;
        await cdp.send('Profiler.start'); profileStarted = true;
      },
      async finish() {
        const endMs = Date.now();
        const probeData = await evaluate('globalThis.__happierPerfProbe.collect()');
        if (probeData.telemetry) telemetry.push(probeData.telemetry);
        const { profile } = await cdp.send('Profiler.stop', {}, { timeout: 60000 }); profileStarted = false; recording = false;
        const pageUrl = await evaluate('location.href');
        const symbols = new Map(), sourceMaps = new Map(), mapFailures = [];
        // Attribution happens after capture, so reading maps does not inflate
        // journey network or CPU counts. No Metro-only symbolication dependency.
        for (const node of profile.nodes) {
          const frame = node.callFrame;
          const script = scripts.get(frame.scriptId);
          if (!script?.sourceMapURL) continue;
          if (!sourceMaps.has(frame.scriptId)) {
            try {
              const mapUrl = script.sourceMapURL.startsWith('data:') ? new URL(script.sourceMapURL) : new URL(script.sourceMapURL, script.url);
              let json;
              if (mapUrl.protocol === 'data:') json = JSON.parse(Buffer.from(mapUrl.href.split(',')[1], 'base64').toString());
              else {
                if (mapUrl.origin !== new URL(script.url).origin) throw new Error('cross-origin map omitted');
                const response = await fetch(mapUrl, { credentials: 'omit', signal: options.signal });
                if (!response.ok) throw new Error('map unavailable');
                json = await response.json();
              }
              sourceMaps.set(frame.scriptId, new SourceMap(json));
            } catch { sourceMaps.set(frame.scriptId, null); mapFailures.push({ scriptId: frame.scriptId, url: safeUrl(script.url) }); }
          }
          const mapped = sourceMaps.get(frame.scriptId)?.findEntry(frame.lineNumber, frame.columnNumber);
          if (mapped?.originalSource) symbols.set(frameKey(frame), { source: mapped.originalSource.split(/[?#]/)[0],
            name: mapped.name ?? frame.functionName, line: mapped.originalLine, column: mapped.originalColumn });
        }
        for (const node of profile.nodes) node.callFrame.url = safeUrl(node.callFrame.url);
        // Keys above use original URLs; transfer mappings after URL redaction.
        const cleanSymbols = new Map();
        for (const [key, value] of symbols) { const parts = JSON.parse(key); parts[1] = safeUrl(parts[1]); cleanSymbols.set(JSON.stringify(parts), value); }
        return { startMs, endMs, durationMs: endMs - startMs, profile, cpu: summarizeProfile(profile, cleanSymbols),
          network: { ...summarizeNetwork(requests), records: requests }, sockets, telemetry,
          react: probeData, observedUi: { url: safeUrl(pageUrl), scripts: [...new Set([...scripts.values()].map(script => safeUrl(script.url)).filter(Boolean))] },
          attribution: { sourceMaps: sourceMaps.size, mappedFrames: symbols.size, mapFailures },
          socketEventsPerSecond: sockets.length * 1000 / (endMs - startMs) };
      },
      async close() {
        try {
          if (profileStarted) await cdp.send('Profiler.stop', {}, { timeout: 60000 });
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
          await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
          await evaluate('globalThis.__happierPerfProbe?.stop()');
          await evaluate('delete globalThis.__HAPPIER_PERF_CAPTURE_MODE__');
        } finally { cdp.close(); }
      },
    };
  } catch (error) { cdp.close(); throw error; }
}
