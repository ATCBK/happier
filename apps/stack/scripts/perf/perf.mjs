import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compareRuns, safeUrl, summarizeLogs } from './analysis.mjs';
import { startCapture } from './capture.mjs';
import { startHostObserver } from './host-snapshot.mjs';
import { summarizeSyncPerformanceSummaries } from '../../../ui/scripts/syncPerformanceTelemetryReport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const children = new Set();
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  abort.abort();
  for (const child of children) child.kill('SIGINT');
});

async function command(executable, args, { stdin = 'ignore', env = process.env, silent = false } = {}) {
  if (abort.signal.aborted) throw new Error('Capture interrupted');
  const child = spawn(executable, args, { cwd: repo, env, stdio: [stdin, silent ? 'ignore' : 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  // Never return command diagnostics: browser failures may contain input or
  // page data. Caller records the phase and exit code instead.
  child.stderr.resume();
  try {
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
    if (code !== 0) throw new Error(`Command failed (${code}); diagnostics suppressed`);
    return stdout;
  } finally { children.delete(child); }
}

const options = Object.fromEntries(process.argv.slice(4).filter(arg => arg.startsWith('--')).map(arg => {
  const index = arg.indexOf('='); return index < 0 ? [arg.slice(2), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });

export async function navigateToRestoreInput(browser, evaluate) {
  while (!await evaluate(`Boolean(document.querySelector('[data-testid="restore-manual-secret-input"]'))`)) {
    await browser(['wait', '--fn', `Boolean(document.querySelector('[data-testid="restore-manual-secret-input"]')) || [...document.querySelectorAll('[role="button"],button')].some(e => e.getClientRects().length && /^(Skip|Use canonical|Use a key)/.test(e.textContent.trim()))`]);
    const label = await evaluate(`(() => { const buttons = [...document.querySelectorAll('[role="button"],button')].filter(e => e.getClientRects().length); return ['Skip', 'Use canonical', 'Use a key'].find(label => buttons.some(e => e.textContent.trim().startsWith(label))); })()`);
    if (label) {
      await browser(['find', 'role', 'button', 'click', '--name', label]);
      // A click can finish before React commits navigation. Wait for the old
      // screen to leave, using the browser's existing wait/actionability budget.
      await browser(['wait', '--fn', `Boolean(document.querySelector('[data-testid="restore-manual-secret-input"]')) || ![...document.querySelectorAll('[role="button"],button')].some(e => e.getClientRects().length && e.textContent.trim().startsWith(${JSON.stringify(label)}))`]);
    }
  }
}

async function loadRuns(path) {
  const absolute = resolve(path);
  try { return [JSON.parse(await readFile(join(absolute, 'bundle.json'), 'utf8'))]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runs = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) if (entry.isDirectory()) runs.push(...await loadRuns(join(absolute, entry.name)));
  if (!runs.length) throw new Error('No bundle.json runs found');
  return runs;
}

async function compare(before, after) {
  const rows = compareRuns(await loadRuns(before), await loadRuns(after));
  const lines = ['| Journey/cache/UI | Metric | Before mean | After mean | Delta |', '| --- | --- | ---: | ---: | ---: |'];
  for (const row of rows) {
    for (const [metric, values] of Object.entries(row.counts)) lines.push(`| ${row.journey}/${row.cache}/${row.uiMode}/${row.captureMode}/schema-${row.version} | ${metric} | ${values.before ?? 'unavailable'} | ${values.after ?? 'unavailable'} | ${values.delta ?? 'unavailable'} |`);
    for (const percentile of ['p50Ms', 'p95Ms']) lines.push(`| ${row.journey}/${row.cache}/${row.uiMode}/${row.captureMode}/schema-${row.version} | ${percentile} (≥5 export repeats) | ${row.beforeTiming?.[percentile] ?? 'unavailable'} | ${row.afterTiming?.[percentile] ?? 'unavailable'} | ${row.beforeTiming && row.afterTiming ? row.afterTiming[percentile] - row.beforeTiming[percentile] : 'unavailable'} |`);
  }
  console.log(lines.join('\n'));
}

async function journey(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('Invalid journey id');
  const definition = JSON.parse(await readFile(options.journey ?? join(here, 'journeys', `${id}.json`), 'utf8'));
  if (definition.id !== id) throw new Error('Journey id does not match definition');
  const session = options.session;
  if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(session)) throw new Error('--session=<lane> is required');
  if (!['cold', 'warm'].includes(options.cache)) throw new Error('--cache=cold|warm is required');
  if (!['export', 'dev'].includes(options['ui-mode'])) throw new Error('--ui-mode=export|dev is required');
  if (!['timing', 'counts'].includes(options['capture-mode'])) throw new Error('--capture-mode=timing|counts is required');
  if (!options.cdp || !options.url || !options['home-selector']) throw new Error('--cdp, --url, --home-selector are required');
  if (options.stack && options.stack !== 'agent-qa-perf') throw new Error('PERF-E2E only uses agent-qa-perf');
  const output = resolve(options.out ?? join(repo, '.happier/qa/perf', session, `${id}-${options.cache}-${Date.now()}`));
  await mkdir(output, { recursive: false, mode: 0o700 }).catch(async error => {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output, { mode: 0o700 });
  });
  let phase = 'setup', capture, browserResult, hostBefore, hostAfter, lanesBefore, lanesAfter, windowHostStart, windowHostEnd, logObserver, observerCleanup, failed = false;
  const viewportDeclaration = options.viewport ?? (definition.viewport ? `${definition.viewport.width}x${definition.viewport.height}` : undefined);
  if (viewportDeclaration && !/^\d+x\d+$/.test(viewportDeclaration)) throw new Error('--viewport must be WIDTHxHEIGHT');
  const viewports = [];
  const attestViewport = async label => {
    const observed = await capture.evaluate('({ width: innerWidth, height: innerHeight, devicePixelRatio, atMs: Date.now() })');
    viewports.push({ phase: label, ...observed });
    if (viewportDeclaration && `${observed.width}x${observed.height}` !== viewportDeclaration) throw new Error('Viewport drift from declared CSS dimensions');
  };
  const saveBrowser = async () => {
    if (!browserResult) return;
    for (const [file, value] of Object.entries({ 'cpu.cpuprofile': browserResult.profile, 'cpu-summary.json': browserResult.cpu,
      'network.json': browserResult.network, 'react.json': browserResult.react, 'sockets.json': browserResult.sockets,
      'store-telemetry.json': summarizeSyncPerformanceSummaries(browserResult.telemetry),
      'browser-capture.json': { ...browserResult, profile: undefined, cpu: undefined, network: undefined, sockets: undefined, telemetry: undefined, react: undefined } })) {
      await writeJson(join(output, file), value);
    }
  };
  const laneLoad = async () => ({ atMs: Date.now(), basis: 'Declared lane report status, not proof of simultaneous capture; actual shared host load is in hostBefore/hostAfter',
    lanes: await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const lane = `B${index + 1}`;
      try { return { lane, status: (await readFile(join(repo, '.project/plans/2026-10-20-performance-program/lanes', `${lane}.md`), 'utf8')).split('\n')[0] }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return { lane, status: 'report unavailable' }; }
    })) });
  const marks = [];
  const browser = args => command('agent-browser', ['--session', session, '--cdp', options.cdp, ...args],
    { env: { ...process.env, AGENT_BROWSER_RESTORE_SAVE: 'never' } });
  const host = () => logObserver.sample();
  const finalizeHost = async bracket => {
    if (!logObserver || observerCleanup) return;
    [hostAfter, lanesAfter] = await Promise.all([host(), laneLoad()]);
    observerCleanup = await logObserver.stop();
    hostAfter.logs = { ...hostAfter.logs, records: logObserver.records.filter(record => record.atMs >= bracket.startMs && record.atMs <= bracket.endMs),
      observation: { status: observerCleanup.status, startMs: logObserver.readiness.initial.atMs, endMs: observerCleanup.terminal?.atMs,
        source: 'Continuous source-side tail -F + existing safe parser; not a late rotating-file snapshot' } };
    await writeJson(join(output, 'host-observer.json'), observerCleanup);
  };
  const requireIdentity = snapshot => {
    for (const role of ['server', 'daemon']) {
      const identity = snapshot.identity.roles?.[role];
      if (!identity?.selected || identity.selected !== identity.loaded || !snapshot[role]) throw new Error(`${role} selected/loaded identity or live PID missing`);
    }
    if (options['ui-mode'] === 'export' && snapshot.identity.sourceUi !== 'export') throw new Error('Loaded UI is not the requested production export');
    if (options['ui-mode'] === 'dev' && snapshot.identity.sourceUi === 'export') throw new Error('Loaded UI is export, not dev');
  };
  const runStep = async step => {
    if (step.when && step.when !== options.cache) return;
    phase = step.op;
    marks.push({ phase, atMs: Date.now() });
    if (step.op === 'open') await browser(['open', step.path ? new URL(step.path, options.url).href : options.url]);
    else if (step.op === 'home') await browser(['wait', options['home-selector']]);
    else if (step.op === 'idle') await delay(step.ms, undefined, { signal: abort.signal });
    else if (step.op === 'browser') await browser(step.args);
    else if (step.op === 'restore') {
      if (!options['restore-stdin']) throw new Error('J1 cold requires a fresh QA browser and --restore-stdin');
      await navigateToRestoreInput(browser, capture.evaluate);
      await browser(['wait', '[data-testid="restore-manual-secret-input"]']);
      await command(process.execPath, [join(here, 'restore.mjs')], { stdin: 'inherit', silent: true,
        env: { ...process.env, PERF_CDP: options.cdp, PERF_ORIGIN: new URL(options.url).origin } });
    } else throw new Error(`Unknown journey operation ${step.op}`);
    await attestViewport(`after.${step.op}`);
  };
  try {
    capture = await startCapture({ cdp: options.cdp, pageId: options['page-id'], cache: options.cache, captureMode: options['capture-mode'], signal: abort.signal });
    phase = 'host-observer-setup'; logObserver = await startHostObserver();
    // Keep our CDP observer alive after SIGINT: finish and cleanup need it.
    // Child browser commands are interrupted separately by the command owner.
    if (viewportDeclaration) await browser(['set', 'viewport', ...viewportDeclaration.split('x')]);
    for (const step of definition.prepare ?? []) await runStep(step);
    await attestViewport('before.capture');
    phase = 'host-before'; [hostBefore, lanesBefore] = await Promise.all([host(Date.now()), laneLoad()]); requireIdentity(hostBefore);
    phase = 'capture-begin';
    await capture.begin();
    phase = 'window-host-start'; windowHostStart = await host(Date.now()); requireIdentity(windowHostStart);
    for (const step of definition.steps) await runStep(step);
    phase = 'window-host-end'; windowHostEnd = await host(Date.now()); requireIdentity(windowHostEnd);
    phase = 'browser-finish'; browserResult = await capture.finish({ onWindowEnd: finalizeHost });
    if (browserResult.collectionErrors.length) throw new Error('Browser finalization incomplete; safe partial evidence retained');
    const expectedInstrumentation = options['capture-mode'] === 'counts';
    if (browserResult.react.instrumentation?.storeTelemetry !== expectedInstrumentation || browserResult.react.instrumentation?.fiberHook !== expectedInstrumentation) {
      throw new Error('RELOAD NEEDED: loaded UI did not establish the requested store/fiber capture mode');
    }
    if (new URL(browserResult.observedUi.url).origin !== new URL(options.url).origin) throw new Error('Observed page left the requested QA UI origin');
    phase = 'host-after'; requireIdentity(hostAfter);
    if (JSON.stringify(hostBefore.identity) !== JSON.stringify(hostAfter.identity)) throw new Error('Runtime identity changed during capture');
    for (const role of ['server', 'daemon']) if (hostBefore[role].pid !== hostAfter[role].pid) throw new Error(`${role} process changed during capture`);
    const server = summarizeLogs(hostAfter.logs.records, browserResult);
    const storeTelemetry = summarizeSyncPerformanceSummaries(browserResult.telemetry);
    const telemetryMeasured = storeTelemetry.events.some(event => event.name === 'sync.performance.scenario.perf-capture-end');
    const counts = { requests: browserResult.network.requests, duplicateCandidates: browserResult.network.duplicateCandidates,
      sessionExactRequests: browserResult.network.routeClasses['session-exact'] ?? 0,
      sessionFixedRouteRequests: browserResult.network.routeClasses['session-fixed-route'] ?? 0,
      machineExactRequests: browserResult.network.routeClasses['machine-exact'] ?? 0,
      encodedBytes: browserResult.network.encodedBytes, commits: browserResult.react.renderers.length ? browserResult.react.commits : null,
      renders: browserResult.react.renderers.length ? browserResult.react.renders : null,
      longTasks: browserResult.react.longTasks.length, socketFrames: browserResult.sockets.length,
      storeNotifications: telemetryMeasured ? storeTelemetry.events.find(event => event.name === 'sync.store.storage.notify')?.count ?? 0 : null,
      selectorEvaluations: telemetryMeasured ? storeTelemetry.events.filter(event => event.name.startsWith('sync.store.storage.selector.')).reduce((sum, event) => sum + event.count, 0) : null,
      databaseAttempts: server.http.length || server.db.attempts ? server.db.attempts : null,
      databaseTransactionPhases: server.http.length || server.db.phaseRecords ? server.db.transactionPhaseRecords : null,
      databasePhaseRecords: server.http.length || server.db.phaseRecords ? server.db.phaseRecords : null,
      serverRequests: server.http.length || server.db.attempts ? server.http.length : null,
      daemonControlRequests: server.daemon.some(event => event.module === 'daemon-control') ? server.daemon.filter(event => event.module === 'daemon-control').length : null,
      browserRpcCalls: browserResult.sockets.filter(event => event.direction === 'sent' && event.event === 'rpc-call').length };
    const gaps = [];
    if (observerCleanup?.status !== 'CLOSED') gaps.push('Continuous host log observer failed; full-window server/daemon counts not established');
    if (expectedInstrumentation && !telemetryMeasured) gaps.push('UI telemetry absent or disabled; no store counters established');
    if (expectedInstrumentation && !browserResult.react.renderers.length) gaps.push('React renderer did not inject the pre-document hook; render counts unavailable');
    if (storeTelemetry.events.some(event => /^sync\.store\.storage\.selector\.[^.]+\.\d+$/.test(event.name))) gaps.push('RELOAD NEEDED: obsolete per-function selector ids loaded');
    if (!server.records.some(record => record.role !== 'daemon' && record.module === 'web-latency')) gaps.push('No server trace records; zero DB/request counts are not established');
    if (!server.daemon.length) gaps.push('No daemon operation records; zero RPC/poll counts are not established');
    if (!browserResult.attribution.mappedFrames) gaps.push('Source maps absent/unreadable; CPU attribution is generated script/symbol only');
    const bundle = { version: 4, journey: id, intent: definition.intent, cache: options.cache, uiMode: options['ui-mode'],
      captureMode: options['capture-mode'], instrumentation: browserResult.react.instrumentation,
      concurrentLaneLoad: { before: lanesBefore, after: lanesAfter },
      status: gaps.length ? 'INCOMPLETE' : 'CAPTURED', gaps, url: safeUrl(options.url), session,
      pageId: capture.cdp.pageId, startMs: browserResult.startMs, endMs: browserResult.endMs, durationMs: browserResult.durationMs,
      observedUi: browserResult.observedUi,
      clock: browserResult.clock,
      viewport: { declared: viewportDeclaration ?? null, observations: viewports },
      readiness: { selector: options['home-selector'], meaning: definition.readiness ?? 'Lane-declared selector only; J1 default is a shell marker, not proof of hydrated Home' },
      counts, socketEventsPerSecond: browserResult.socketEventsPerSecond,
      sameWindowProcessSamples: { start: windowHostStart, end: windowHostEnd,
        note: 'Interior control-channel endpoint samples inside the browser bracket, not whole-window/peak measurements. Sampling adds overhead; processes are shared across all clients. Operation/constructor counts remain unavailable unless existing logs report them.' },
      processWindow: { startMs: hostBefore.atMs, endMs: hostAfter.atMs,
        note: 'Outer host endpoint samples bracket the browser window. Observer setup and map symbolication are outside these samples. RSS is endpoint samples, not peak/live heap; shared processes include all clients.',
        ...Object.fromEntries(['server', 'daemon'].map(role => [role, {
          cpuSeconds: hostAfter[role].cpuSeconds - hostBefore[role].cpuSeconds,
          averageCpuPercent: 100000 * (hostAfter[role].cpuSeconds - hostBefore[role].cpuSeconds) / (hostAfter.atMs - hostBefore.atMs),
          beforeRssBytes: hostBefore[role].rssBytes, afterRssBytes: hostAfter[role].rssBytes,
        }])) },
      marks, attribution: browserResult.attribution, hostBefore, hostAfter,
      correlation: { basis: 'Only actual returned request IDs are joined; independent relay ids and timestamp proximity are not causal joins. Prisma spans are model/transaction attempts, not physical SQL counts.',
        browserServer: browserResult.network.records.filter(request => request.serverRequestId).map(request => ({ browserRequestId: request.requestId, serverRequestId: request.serverRequestId,
          matchingTraceRecords: server.records.filter(record => record.role === 'server' && record.requestId === request.serverRequestId).length })),
        daemonPolls: 'unavailable: successful pings suppressed; control completions and socket frames are not poll/RPC rates',
        processScope: 'shared process CPU/RSS, includes all clients; no proportional lane or idle-backend allocation' },
      timingPolicy: 'Individual durations include browser automation overhead. Compare reports p50/p95 only for ≥5 complete export timing-mode runs per cold/warm group with store telemetry and fiber hook observed OFF; count-mode durations are never timing evidence. Shared lane contention is not a quiet-host baseline.' };
    await saveBrowser();
    await writeJson(join(output, 'server-daemon.json'), server);
    await writeJson(join(output, 'bundle.json'), bundle);
    console.log(JSON.stringify({ output, status: bundle.status, counts, gaps }));
    if (gaps.length) process.exitCode = 2;
  } catch (error) {
    failed = true;
    if (error.captureDiagnostics?.cleanup) await writeJson(join(output, 'cleanup.json'), error.captureDiagnostics.cleanup);
    const partialErrors = [];
    if (!browserResult && capture) {
      try { browserResult = await capture.finish({ onWindowEnd: finalizeHost }); }
      catch { partialErrors.push({ phase: 'failure.finish', error: 'Partial finalization unavailable; details suppressed' }); }
    }
    await saveBrowser();
    if (!hostAfter && browserResult && Number.isFinite(browserResult.startMs) && !abort.signal.aborted) {
      try { await finalizeHost(browserResult); }
      catch { partialErrors.push({ phase: 'failure.host-after', error: 'Remote diagnostic source unavailable; details suppressed' }); }
    }
    if (hostAfter && browserResult) await writeJson(join(output, 'server-daemon.json'), summarizeLogs(hostAfter.logs.records, browserResult));
    await writeJson(join(output, 'failure.json'), { phase, error: error.message, captureMode: options['capture-mode'],
      captureDiagnostics: error.captureDiagnostics, partialErrors, concurrentLaneLoad: { before: lanesBefore, after: lanesAfter },
      viewport: { declared: viewportDeclaration ?? null, observations: viewports }, marks, hostBefore, hostAfter, windowHostStart, windowHostEnd });
    const partialStore = browserResult ? summarizeSyncPerformanceSummaries(browserResult.telemetry) : null;
    const storeMeasured = partialStore?.events.some(event => event.name === 'sync.performance.scenario.perf-capture-end');
    await writeJson(join(output, 'bundle.json'), { version: 4, journey: id, status: 'FAILED', failedPhase: phase,
      eligible: false, cache: options.cache, uiMode: options['ui-mode'], captureMode: options['capture-mode'],
      startMs: browserResult?.startMs, endMs: browserResult?.endMs, durationMs: browserResult?.durationMs,
      counts: { requests: Number.isFinite(browserResult?.startMs) ? browserResult.network.requests : null,
        encodedBytes: Number.isFinite(browserResult?.startMs) ? browserResult.network.encodedBytes : null,
        commits: browserResult?.react?.renderers?.length ? browserResult.react.commits : null,
        renders: browserResult?.react?.renderers?.length ? browserResult.react.renders : null,
        socketFrames: Number.isFinite(browserResult?.startMs) ? browserResult.sockets.length : null,
        storeNotifications: storeMeasured ? partialStore.events.find(event => event.name === 'sync.store.storage.notify')?.count ?? 0 : null,
        selectorEvaluations: storeMeasured ? partialStore.events.filter(event => event.name.startsWith('sync.store.storage.selector.')).reduce((sum, event) => sum + event.count, 0) : null },
      instrumentation: browserResult?.react?.instrumentation,
      clock: browserResult?.clock,
      concurrentLaneLoad: { before: lanesBefore, after: lanesAfter },
      gaps: ['Failed journey: partial evidence is diagnostic only; never accepted timing/count comparison evidence'] });
    throw error;
  } finally {
    if (logObserver && !observerCleanup) {
      observerCleanup = await logObserver.stop();
      await writeJson(join(output, 'host-observer.json'), observerCleanup);
    }
    if (capture) {
      const cleanup = await capture.close({ attestOff: failed || abort.signal.aborted });
      await writeJson(join(output, 'cleanup.json'), cleanup);
      if (cleanup.status !== 'CLEANED') {
        console.error('CDP cleanup failed; see cleanup.json; saved-window status is separate from cleanup');
        process.exitCode = 1;
      }
    }
  }
}

export async function runPerformanceCli(argv = process.argv.slice(2)) {
  const [mode, id, after] = argv;
  if (mode === 'compare' && id && after) await compare(id, after);
  else if (mode === 'journey' && id) await journey(id).catch(error => { console.error(error.message); process.exitCode = 1; });
  else console.log('node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs journey J1|J13 --session=P0-H --cdp=http://127.0.0.1:PORT --url=QA_URL --home-selector=CSS --cache=cold|warm --ui-mode=export|dev --capture-mode=timing|counts [--restore-stdin] [--out=NEW_DIRECTORY] [--journey=JSON_PATH] [--page-id=ID]\nnode apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs compare BEFORE_DIRECTORY AFTER_DIRECTORY');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runPerformanceCli();
