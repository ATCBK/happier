import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { connectPage } from './cdp.mjs';
import { frameKey, requestFingerprint, safeUrl, summarizeNetwork, summarizeProfile } from './analysis.mjs';

// Counts-only diagnostic budget: retain at most eight async scheduling hops.
// This bounds debugger bookkeeping, not user work or the synchronous frames.
const COUNTS_ASYNC_STACK_DEPTH = 8;

function stackFrames(stack, parents = COUNTS_ASYNC_STACK_DEPTH) {
  return stack ? [...(stack.callFrames ?? []).map(frame => ({ functionName: frame.functionName, url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber })),
    ...(parents > 0 ? stackFrames(stack.parent, parents - 1) : [])] : [];
}

function pageAuthSurface() {
  const visible = selector => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length > 0);
  const welcome = visible('[data-testid="welcome-decision-panel"], [data-testid="unauth-shell-brand-pane"]');
  const shell = visible('[data-testid="session-list-view-options-trigger"], [data-testid="home-header-start-new-session"], [data-testid="app-shell-title-strip"]');
  return { surface: welcome ? 'welcome' : shell ? 'shell' : 'unknown',
    authenticated: null, basis: 'visible DOM markers only; not credential authority',
    retirementReasonCode: null, retirementReasonAvailability: 'not exposed by the app browser surface' };
}

export async function startCapture(options) {
  if (!['timing', 'counts'].includes(options.captureMode)) throw new Error('Explicit captureMode=timing|counts required');
  let cdp;
  try { cdp = await connectPage(options.cdp, options.pageId, options.signal); }
  catch {
    const error = new Error('CDP setup.connect failed; discovery/transport details suppressed');
    error.captureDiagnostics = { setup: { phase: 'setup.connect', kind: 'discovery-or-transport' }, cleanup: { status: 'NOT_CONNECTED', authState: null, asyncCallStackDepth: null } };
    throw error;
  }
  const salt = randomBytes(32).toString('hex');
  const requests = [], sockets = [], telemetry = [], scripts = new Map(), nativePairs = [];
  const initiatorWork = [];
  let asyncCallStackDepth = null, beginAuthState = null;
  const requestedAsyncDepth = options.captureMode === 'counts' ? COUNTS_ASYNC_STACK_DEPTH : 0;
  const expandStack = async (stack, parents = requestedAsyncDepth, seen = new Set()) => {
    if (!stack) return [];
    const frames = stackFrames(stack, 0);
    if (!parents) return frames;
    let parent = stack.parent;
    if (!parent && stack.parentId) {
      const key = JSON.stringify(stack.parentId);
      if (seen.has(key)) return frames;
      seen.add(key);
      parent = (await cdp.send('Debugger.getStackTrace', { stackTraceId: stack.parentId })).stackTrace;
    }
    return [...frames, ...await expandStack(parent, parents - 1, seen)];
  };
  const inFlight = new Map();
  let recording = false, profileStarted = false, identifier, finished, unmappedRequests = 0;
  let startMs, phase = 'setup.connect';
  const diagnostic = (error, failedPhase) => ({ phase: failedPhase,
    kind: /timeout|timed out/i.test(error.message) ? 'timeout' : /closed|disconnect|socket/i.test(error.message) ? 'transport-closed' : 'protocol-or-evaluation' });
  const step = async (name, operation) => { phase = name; return await operation(); };
  const at = (timestamp, request) => timestamp * 1000 + request.clockOffsetMs;
  cdp.on('Debugger.scriptParsed', event => scripts.set(event.scriptId, { url: event.url, sourceMapURL: event.sourceMapURL }));
  cdp.on('Network.requestWillBeSent', event => {
    // Both clocks are sampled together by Chromium, not by a queued renderer
    // evaluation. Keep preparation pairs too: an idle window may have sockets
    // before its first new HTTP request (or no HTTP requests at all).
    const paired = Number.isFinite(event.wallTime) && Number.isFinite(event.timestamp);
    const clockOffsetMs = paired ? event.wallTime * 1000 - event.timestamp * 1000 : undefined;
    if (paired) nativePairs.push({ wallTime: event.wallTime, timestamp: event.timestamp, offsetMs: clockOffsetMs });
    if (!recording) return;
    if (!paired) unmappedRequests++;
    if (event.redirectResponse && inFlight.has(event.requestId)) {
      const prior = inFlight.get(event.requestId);
      prior.endMs = at(event.timestamp, prior);
      prior.status = event.redirectResponse.status;
    }
    const row = { id: `${event.requestId}:${requests.length}`, requestId: event.requestId,
      endpoint: safeUrl(event.request.url), method: event.request.method,
      startMs: paired ? event.wallTime * 1000 : undefined, requestStartMs: paired ? event.wallTime * 1000 : undefined,
      nativeWallTime: event.wallTime, nativeTimestamp: event.timestamp, clockOffsetMs,
      fingerprint: requestFingerprint(event.request, salt),
      bodyUnknown: Boolean(event.request.hasPostData && !event.request.postData),
      requestBodyBytes: event.request.postData === undefined ? null : Buffer.byteLength(event.request.postData),
      initiator: { type: event.initiator?.type, stack: stackFrames(event.initiator?.stack, requestedAsyncDepth) } };
    requests.push(row); inFlight.set(event.requestId, row);
    if (requestedAsyncDepth) initiatorWork.push(expandStack(event.initiator?.stack)
      .then(frames => { row.initiator.stack = frames; })
      .catch(() => { row.initiator.asyncStackUnavailable = true; }));
  });
  cdp.on('Network.responseReceived', event => {
    const row = inFlight.get(event.requestId);
    if (!row) return;
    row.status = event.response.status;
    row.fromCache = Boolean(event.response.fromDiskCache || event.response.fromServiceWorker);
    row.mimeType = event.response.mimeType;
    row.responseReceivedMs = at(event.timestamp, row);
    row.nativeResponseTimestamp = event.timestamp;
    const timing = event.response.timing;
    if (timing && timing.requestTime >= 0) {
      row.requestStartMs = at(timing.requestTime, row);
      if (timing.sendStart >= 0) row.sendStartMs = at(timing.requestTime, row) + timing.sendStart;
      if (timing.receiveHeadersStart >= 0) row.responseHeadersMs = at(timing.requestTime, row) + timing.receiveHeadersStart;
    }
    row.ttfbMs = (row.responseHeadersMs ?? row.responseReceivedMs) - row.requestStartMs;
    row.ttfbBasis = row.responseHeadersMs === undefined ? 'responseReceived.timestamp (headers timing unavailable)' : 'response.timing.receiveHeadersStart';
    if (row.sendStartMs !== undefined) row.sendToHeadersMs = (row.responseHeadersMs ?? row.responseReceivedMs) - row.sendStartMs;
    const header = Object.entries(event.response.headers).find(([key]) => key.toLowerCase() === 'x-request-id');
    if (header && /^[a-zA-Z0-9._:-]+$/.test(String(header[1]))) row.serverRequestId = header[1];
  });
  cdp.on('Network.loadingFinished', event => {
    const row = inFlight.get(event.requestId);
    if (row) { row.endMs = at(event.timestamp, row); row.nativeEndTimestamp = event.timestamp; row.encodedBytes = event.encodedDataLength; inFlight.delete(event.requestId); }
  });
  cdp.on('Network.loadingFailed', event => {
    const row = inFlight.get(event.requestId);
    if (row) {
      row.endMs = at(event.timestamp, row); row.nativeEndTimestamp = event.timestamp; row.failed = true; row.canceled = typeof event.canceled === 'boolean' ? event.canceled : null;
      // CDP errorText can contain arbitrary content; retain only Chromium's code.
      row.failureCode = /^net::ERR_[A-Z0-9_]+$/.test(event.errorText) ? event.errorText : 'unclassified';
      if (/^[a-zA-Z0-9_-]+$/.test(event.blockedReason ?? '')) row.blockedReason = event.blockedReason;
      if (/^[a-zA-Z0-9_-]+$/.test(event.corsErrorStatus?.corsError ?? '')) row.corsError = event.corsErrorStatus.corsError;
      inFlight.delete(event.requestId);
    }
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
    sockets.push({ nativeTimestamp: event.timestamp, direction: direction.toLowerCase(), opcode,
      bytes: opcode === 2 ? Buffer.byteLength(payloadData, 'base64') : Buffer.byteLength(payloadData),
      event: name ?? 'protocol-or-binary', ...(rpcMethod ? { rpcMethod } : {}) });
  });
  cdp.on('Runtime.bindingCalled', event => {
    if (!recording || event.name !== '__happierPerfTelemetry') return;
    try { telemetry.push(JSON.parse(event.payload)); } catch {}
  });
  const evaluate = async expression => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Browser probe evaluation failed (details suppressed)');
    return result.result.value;
  };
  const close = async ({ attestOff = false } = {}) => {
    const operations = [], errors = [];
    const attempt = async (name, operation) => {
      try { const result = await operation(); operations.push({ phase: name, status: 'ok' }); return result; }
      catch (error) { const result = diagnostic(error, name); errors.push(result); operations.push({ ...result, status: 'failed' }); }
    };
    let off, authState;
    try {
      authState = await attempt('cleanup.auth-surface', () => evaluate(`(${pageAuthSurface.toString()})()`));
      await attempt('cleanup.Debugger.asyncStacksOff', async () => {
        await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 0 }); asyncCallStackDepth = 0;
      });
      if (profileStarted) await attempt('cleanup.Profiler.stop', async () => { await cdp.send('Profiler.stop', {}, { timeout: 60000 }); profileStarted = false; });
      await attempt('cleanup.Network.setCacheDisabled', () => cdp.send('Network.setCacheDisabled', { cacheDisabled: false }));
      if (identifier) await attempt('cleanup.Page.removeScript', () => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }));
      await attempt('cleanup.probe.stop', () => evaluate('globalThis.__happierPerfProbe?.stop(); delete globalThis.__HAPPIER_PERF_CAPTURE_MODE__'));
      await attempt('cleanup.Runtime.removeBinding', () => cdp.send('Runtime.removeBinding', { name: '__happierPerfTelemetry' }));
      if (attestOff) {
        // A counts-mode instance cannot be turned OFF by removing injection:
        // its constructor already ran. Attest a fresh document instead.
        let offIdentifier;
        try {
          const added = await attempt('cleanup.OFF.addScript', () => cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = "timing"; globalThis.__HAPPIER_PERF_OFF_DOCUMENT__ = ${JSON.stringify(salt)};` }));
          offIdentifier = added?.identifier;
          await attempt('cleanup.OFF.reload', () => cdp.send('Page.reload'));
          off = await attempt('cleanup.OFF.attest', () => evaluate(`new Promise(resolve => { const check = () => {
            const api = globalThis.__HAPPIER_SYNC_PERFORMANCE__;
            if (globalThis.__HAPPIER_PERF_OFF_DOCUMENT__ === ${JSON.stringify(salt)} && api?.isEnabled) resolve({ atMs: Date.now(), storeTelemetry: api.isEnabled(), fiberHook: Boolean(globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__), viewport: { width: innerWidth, height: innerHeight }, authState: (${pageAuthSurface.toString()})() });
            else requestAnimationFrame(check);
          }; check(); })`));
        } finally {
          if (offIdentifier) await attempt('cleanup.OFF.removeScript', () => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: offIdentifier }));
          await attempt('cleanup.OFF.removeOverride', () => evaluate('delete globalThis.__HAPPIER_PERF_CAPTURE_MODE__; delete globalThis.__HAPPIER_PERF_OFF_DOCUMENT__'));
        }
      }
    } finally { recording = false; cdp.close(); }
    return { status: errors.length || attestOff && (off?.storeTelemetry !== false || off?.fiberHook !== false) ? 'CLEANUP_FAILED' : 'CLEANED', operations, errors,
      asyncCallStackDepth, authState: authState ?? null,
      ...(attestOff ? { freshDocumentOffAttestation: off ?? null } : {}) };
  };
  try {
    for (const domain of ['Page', 'Network', 'Runtime', 'Debugger', 'Profiler']) await step(`setup.${domain}.enable`, () => cdp.send(`${domain}.enable`));
    await step('setup.Debugger.asyncStacks', async () => {
      await cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: requestedAsyncDepth }); asyncCallStackDepth = requestedAsyncDepth;
    });
    await step('setup.Runtime.addBinding', () => cdp.send('Runtime.addBinding', { name: '__happierPerfTelemetry' }));
    const probe = `globalThis.__HAPPIER_PERF_CAPTURE_MODE__ = ${JSON.stringify(options.captureMode)};\n` + await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
    ({ identifier } = await step('setup.Page.addScript', () => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe })));
    // Install on an already loaded J13 page too, then reload through the journey
    // preparation so React sees the hook before its renderer initializes.
    await step('setup.probe.install', () => evaluate(probe));
    return { cdp, evaluate,
      async begin() {
        beginAuthState = await evaluate(`(${pageAuthSurface.toString()})()`);
        await evaluate('globalThis.__happierPerfProbe.reset()');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: options.cache === 'cold' });
        if (options.cache === 'cold') await cdp.send('Network.clearBrowserCache');
        startMs = Date.now(); recording = true;
        await cdp.send('Profiler.start'); profileStarted = true;
      },
      async finish({ onWindowEnd } = {}) {
        if (finished) return finished;
        const endMs = Date.now();
        const errors = [];
        const available = async (name, operation) => {
          try { return await operation(); } catch (error) { errors.push(diagnostic(error, name)); return null; }
        };
        const probeData = await available('finish.probe.collect', () => evaluate('globalThis.__happierPerfProbe.collect()'));
        if (probeData?.telemetry) telemetry.push(probeData.telemetry);
        const stopped = profileStarted ? await available('finish.Profiler.stop', () => cdp.send('Profiler.stop', {}, { timeout: 60000 })) : null;
        if (stopped) profileStarted = false;
        recording = false;
        await available('finish.async-initiators', () => Promise.all(initiatorWork));
        if (requests.some(row => row.initiator.asyncStackUnavailable)) errors.push({ phase: 'finish.async-initiators', kind: 'parent-stack-unavailable' });
        const endAuthState = await available('finish.auth-surface', () => evaluate(`(${pageAuthSurface.toString()})()`));
        if (probeData?.instrumentation) probeData.instrumentation.asyncCallStackDepth = asyncCallStackDepth;
        const profile = stopped?.profile;
        const pageUrl = await available('finish.page.attest', () => evaluate('location.href'));
        // Read rotating server evidence before potentially large source maps.
        // This callback is outside the capture bracket/profile, not a wait for
        // new work or a synthetic extension of the measured interval.
        if (onWindowEnd) await available('finish.window-evidence', () => onWindowEnd({ startMs, endMs }));
        const symbols = new Map(), sourceMaps = new Map(), mapFailures = [], mapResponses = [];
        // Attribution happens after capture, so reading maps does not inflate
        // journey network or CPU counts. No Metro-only symbolication dependency.
        for (const node of profile?.nodes ?? []) {
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
                mapResponses.push({ script: safeUrl(script.url), map: safeUrl(mapUrl.href), status: response.status });
              }
              sourceMaps.set(frame.scriptId, new SourceMap(json));
            } catch { sourceMaps.set(frame.scriptId, null); mapFailures.push({ scriptId: frame.scriptId, url: safeUrl(script.url) }); }
          }
          const mapped = sourceMaps.get(frame.scriptId)?.findEntry(frame.lineNumber, frame.columnNumber);
          if (mapped?.originalSource) symbols.set(frameKey(frame), { source: mapped.originalSource.split(/[?#]/)[0],
            name: mapped.name ?? frame.functionName, line: mapped.originalLine, column: mapped.originalColumn });
        }
        for (const node of profile?.nodes ?? []) node.callFrame.url = safeUrl(node.callFrame.url);
        // Keys above use original URLs; transfer mappings after URL redaction.
        const cleanSymbols = new Map();
        for (const [key, value] of symbols) { const parts = JSON.parse(key); parts[1] = safeUrl(parts[1]); cleanSymbols.set(JSON.stringify(parts), value); }
        const windowRequests = requests.filter(row => row.startMs >= startMs && row.startMs <= endMs).map(row => ({ ...row,
          pendingAtEnd: row.endMs === undefined || row.endMs > endMs, completedAfterWindow: row.endMs > endMs }));
        const orderedPairs = [...nativePairs].sort((a, b) => a.timestamp - b.timestamp);
        const mappedSockets = sockets.map(row => {
          let low = 0, high = orderedPairs.length;
          while (low < high) { const middle = (low + high) >>> 1;
            if (orderedPairs[middle].timestamp <= row.nativeTimestamp) low = middle + 1; else high = middle; }
          const pair = orderedPairs[Math.max(0, low - 1)];
          return { ...row, atMs: pair ? row.nativeTimestamp * 1000 + pair.offsetMs : null };
        });
        const unmappedSocketFrames = mappedSockets.filter(row => row.atMs === null).length;
        if (unmappedRequests || unmappedSocketFrames) errors.push({ phase: 'finish.clock', kind: 'native-clock-pair-unavailable' });
        const windowSockets = mappedSockets.filter(row => row.atMs !== null && row.atMs >= startMs && row.atMs <= endMs);
        return finished = { startMs, endMs, durationMs: endMs - startMs, profile: profile ?? null, cpu: profile ? summarizeProfile(profile, cleanSymbols) : null,
          network: { ...summarizeNetwork(windowRequests, { startMs, endMs }), records: windowRequests, observedThroughMs: Date.now() }, sockets: windowSockets, telemetry,
          react: probeData, authState: { begin: beginAuthState, end: endAuthState }, observedUi: { url: safeUrl(pageUrl), scripts: [...new Set([...scripts.values()].map(script => safeUrl(script.url)).filter(Boolean))] },
          attribution: { sourceMaps: [...sourceMaps.values()].filter(Boolean).length, attemptedSourceMaps: sourceMaps.size,
            mappedFrames: symbols.size, mapResponses, mapFailures },
          clock: { basis: 'Native Network.requestWillBeSent wallTime/timestamp pairs; request-local conversion, preceding pair (first pair for earlier sockets)',
            rendererRoundTripUsed: false, controllerWindowClock: 'Date.now', nativePairs: [...nativePairs], unmappedRequests, unmappedSocketFrames,
            ...(unmappedSocketFrames ? { unmappedSocketRecords: mappedSockets.filter(row => row.atMs === null) } : {}) },
          collectionErrors: errors, socketEventsPerSecond: windowSockets.length * 1000 / (endMs - startMs) };
      },
      close,
    };
  } catch (error) {
    const setup = diagnostic(error, phase);
    const cleanup = await close();
    const failure = new Error(`CDP ${setup.phase} failed (${setup.kind}; details suppressed)`);
    failure.captureDiagnostics = { setup, cleanup };
    throw failure;
  }
}
