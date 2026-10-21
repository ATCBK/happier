import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { compareRuns, safeUrl, summarizeLogs } from './analysis.mjs';
import { startCapture } from './capture.mjs';
import { summarizeSyncPerformanceSummaries } from '../../../ui/scripts/syncPerformanceTelemetryReport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const launcher = join(repo, 'apps/stack/scripts/repo_local.mjs');
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
    for (const [metric, values] of Object.entries(row.counts)) lines.push(`| ${row.journey}/${row.cache}/${row.uiMode}/${row.captureMode} | ${metric} | ${values.before ?? 'unavailable'} | ${values.after ?? 'unavailable'} | ${values.delta ?? 'unavailable'} |`);
    for (const percentile of ['p50Ms', 'p95Ms']) lines.push(`| ${row.journey}/${row.cache}/${row.uiMode}/${row.captureMode} | ${percentile} (≥5 export repeats) | ${row.beforeTiming?.[percentile] ?? 'unavailable'} | ${row.afterTiming?.[percentile] ?? 'unavailable'} | ${row.beforeTiming && row.afterTiming ? row.afterTiming[percentile] - row.beforeTiming[percentile] : 'unavailable'} |`);
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
  let phase = 'setup', capture, browserResult, hostBefore, hostAfter, lanesBefore, lanesAfter;
  const laneLoad = async () => ({ atMs: Date.now(), basis: 'Declared lane report status, not proof of simultaneous capture; actual shared host load is in hostBefore/hostAfter',
    lanes: await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const lane = `B${index + 1}`;
      try { return { lane, status: (await readFile(join(repo, '.project/plans/2026-10-20-performance-program/lanes', `${lane}.md`), 'utf8')).split('\n')[0] }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return { lane, status: 'report unavailable' }; }
    })) });
  const marks = [];
  const browser = args => command('agent-browser', ['--session', session, '--cdp', options.cdp, ...args],
    { env: { ...process.env, AGENT_BROWSER_RESTORE_SAVE: 'never' } });
  const host = async (startMs, endMs) => {
    const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
    const { resolveRemoteStackStatePaths } = await import('../utils/dev_targets/remote_commands.mjs');
    const { config } = await loadDevTargetsConfig({ stackName: 'agent-qa-perf' });
    const serverTarget = config.runtimePlacement.server.target, daemonTarget = config.runtimePlacement.daemon.target;
    if (!serverTarget || serverTarget !== daemonTarget) throw new Error('This capture requires the configured colocated perf server and daemon');
    const target = config.targets.find(candidate => candidate.name === serverTarget);
    const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa-perf', runtimeMode: 'controlled' });
    const json = JSON.stringify({ stack: 'agent-qa-perf', stackBaseDir: paths.stackBaseDir, startMs, endMs });
    const raw = await command(process.execPath, [launcher, 'dev-targets', 'exec', serverTarget, '--stack=agent-qa-perf', '--',
      'node', 'apps/stack/scripts/perf/host-snapshot.mjs', json]);
    const line = raw.split('\n').find(value => value.startsWith('HAPPIER_PERF_HOST='));
    if (!line) throw new Error('Host snapshot missing');
    const result = JSON.parse(line.slice('HAPPIER_PERF_HOST='.length));
    result.target = serverTarget;
    return result;
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
  };
  try {
    capture = await startCapture({ cdp: options.cdp, pageId: options['page-id'], cache: options.cache, captureMode: options['capture-mode'], signal: abort.signal });
    abort.signal.addEventListener('abort', () => capture.cdp.close(), { once: true });
    for (const step of definition.prepare ?? []) await runStep(step);
    phase = 'host-before'; [hostBefore, lanesBefore] = await Promise.all([host(Date.now()), laneLoad()]); requireIdentity(hostBefore);
    await capture.begin();
    for (const step of definition.steps) await runStep(step);
    phase = 'browser-finish'; browserResult = await capture.finish();
    const expectedInstrumentation = options['capture-mode'] === 'counts';
    if (browserResult.react.instrumentation?.storeTelemetry !== expectedInstrumentation || browserResult.react.instrumentation?.fiberHook !== expectedInstrumentation) {
      throw new Error('RELOAD NEEDED: loaded UI did not establish the requested store/fiber capture mode');
    }
    if (new URL(browserResult.observedUi.url).origin !== new URL(options.url).origin) throw new Error('Observed page left the requested QA UI origin');
    phase = 'host-after'; [hostAfter, lanesAfter] = await Promise.all([host(browserResult.startMs, browserResult.endMs), laneLoad()]); requireIdentity(hostAfter);
    if (JSON.stringify(hostBefore.identity) !== JSON.stringify(hostAfter.identity)) throw new Error('Runtime identity changed during capture');
    for (const role of ['server', 'daemon']) if (hostBefore[role].pid !== hostAfter[role].pid) throw new Error(`${role} process changed during capture`);
    const server = summarizeLogs(hostAfter.logs.records, browserResult);
    const storeTelemetry = summarizeSyncPerformanceSummaries(browserResult.telemetry);
    const telemetryMeasured = storeTelemetry.events.some(event => event.name === 'sync.performance.scenario.perf-capture-end');
    const counts = { requests: browserResult.network.requests, duplicateCandidates: browserResult.network.duplicateCandidates,
      encodedBytes: browserResult.network.encodedBytes, commits: browserResult.react.renderers.length ? browserResult.react.commits : null,
      renders: browserResult.react.renderers.length ? browserResult.react.renders : null,
      longTasks: browserResult.react.longTasks.length, socketFrames: browserResult.sockets.length,
      storeNotifications: telemetryMeasured ? storeTelemetry.events.find(event => event.name === 'sync.store.storage.notify')?.count ?? 0 : null,
      selectorEvaluations: telemetryMeasured ? storeTelemetry.events.filter(event => event.name.startsWith('sync.store.storage.selector.')).reduce((sum, event) => sum + event.count, 0) : null,
      databaseAttempts: server.http.length || server.db.attempts ? server.db.attempts : null,
      serverRequests: server.http.length || server.db.attempts ? server.http.length : null,
      daemonControlRequests: server.daemon.filter(event => event.module === 'daemon-control').length,
      browserRpcCalls: browserResult.sockets.filter(event => event.direction === 'sent' && event.event === 'rpc-call').length };
    const gaps = [];
    if (expectedInstrumentation && !telemetryMeasured) gaps.push('UI telemetry absent or disabled; no store counters established');
    if (expectedInstrumentation && !browserResult.react.renderers.length) gaps.push('React renderer did not inject the pre-document hook; render counts unavailable');
    if (storeTelemetry.events.some(event => /^sync\.store\.storage\.selector\.[^.]+\.\d+$/.test(event.name))) gaps.push('RELOAD NEEDED: obsolete per-function selector ids loaded');
    if (!server.records.some(record => record.role !== 'daemon' && record.module === 'web-latency')) gaps.push('No server trace records; zero DB/request counts are not established');
    if (!server.daemon.length) gaps.push('No daemon operation records; zero RPC/poll counts are not established');
    if (!browserResult.attribution.mappedFrames) gaps.push('Source maps absent/unreadable; CPU attribution is generated script/symbol only');
    const bundle = { version: 2, journey: id, intent: definition.intent, cache: options.cache, uiMode: options['ui-mode'],
      captureMode: options['capture-mode'], instrumentation: browserResult.react.instrumentation,
      concurrentLaneLoad: { before: lanesBefore, after: lanesAfter },
      status: gaps.length ? 'INCOMPLETE' : 'CAPTURED', gaps, url: safeUrl(options.url), session,
      pageId: capture.cdp.pageId, startMs: browserResult.startMs, endMs: browserResult.endMs, durationMs: browserResult.durationMs,
      observedUi: browserResult.observedUi,
      counts, socketEventsPerSecond: browserResult.socketEventsPerSecond,
      processWindow: { startMs: hostBefore.atMs, endMs: hostAfter.atMs,
        note: 'Host CPU/RSS samples bracket the browser window and include remote-command setup/finalization; RSS is endpoint samples, not peak/live heap.',
        ...Object.fromEntries(['server', 'daemon'].map(role => [role, {
          cpuSeconds: hostAfter[role].cpuSeconds - hostBefore[role].cpuSeconds,
          averageCpuPercent: 100000 * (hostAfter[role].cpuSeconds - hostBefore[role].cpuSeconds) / (hostAfter.atMs - hostBefore.atMs),
          beforeRssBytes: hostBefore[role].rssBytes, afterRssBytes: hostAfter[role].rssBytes,
        }])) },
      marks, attribution: browserResult.attribution, hostBefore, hostAfter,
      correlation: 'CDP wall/monotonic offset; server SQL→HTTP by trace requestId; UI→server by returned request id when present, otherwise time window only',
      timingPolicy: 'Individual durations include browser automation overhead. Compare reports p50/p95 only for ≥5 complete export timing-mode runs per cold/warm group with store telemetry and fiber hook observed OFF; count-mode durations are never timing evidence. Shared lane contention is not a quiet-host baseline.' };
    await writeJson(join(output, 'cpu.cpuprofile'), browserResult.profile);
    await writeJson(join(output, 'cpu-summary.json'), browserResult.cpu);
    await writeJson(join(output, 'network.json'), browserResult.network);
    await writeJson(join(output, 'react.json'), browserResult.react);
    await writeJson(join(output, 'store-telemetry.json'), storeTelemetry);
    await writeJson(join(output, 'sockets.json'), browserResult.sockets);
    await writeJson(join(output, 'server-daemon.json'), server);
    await writeJson(join(output, 'bundle.json'), bundle);
    console.log(JSON.stringify({ output, status: bundle.status, counts, gaps }));
    if (gaps.length) process.exitCode = 2;
  } catch (error) {
    if (browserResult) {
      // A missing remote log/process source must not discard the already
      // captured browser evidence. These files remain explicitly incomplete.
      await writeJson(join(output, 'cpu.cpuprofile'), browserResult.profile);
      await writeJson(join(output, 'cpu-summary.json'), browserResult.cpu);
      await writeJson(join(output, 'network.json'), browserResult.network);
      await writeJson(join(output, 'react.json'), browserResult.react);
      await writeJson(join(output, 'sockets.json'), browserResult.sockets);
    }
    await writeJson(join(output, 'failure.json'), { phase, error: error.message, captureMode: options['capture-mode'], concurrentLaneLoad: { before: lanesBefore, after: lanesAfter }, marks, hostBefore, hostAfter });
    throw error;
  } finally { await capture?.close(); }
}

export async function runPerformanceCli(argv = process.argv.slice(2)) {
  const [mode, id, after] = argv;
  if (mode === 'compare' && id && after) await compare(id, after);
  else if (mode === 'journey' && id) await journey(id).catch(error => { console.error(error.message); process.exitCode = 1; });
  else console.log('node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs journey J1|J13 --session=P0-H --cdp=http://127.0.0.1:PORT --url=QA_URL --home-selector=CSS --cache=cold|warm --ui-mode=export|dev --capture-mode=timing|counts [--restore-stdin] [--out=NEW_DIRECTORY] [--journey=JSON_PATH] [--page-id=ID]\nnode apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs compare BEFORE_DIRECTORY AFTER_DIRECTORY');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runPerformanceCli();
