import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants, tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithCommandResult, runCommand, spawnForegroundCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';

import { prepareTypeScriptProjectBuildFromArgs, verifyTypeScriptProjectCoverage } from './prepareTypeScriptProjectBuild.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { prepareReferencedTypecheckDeclarations } from './prepareReferencedTypecheckDeclarations.mjs';
import { createTypecheckDiagnosticRun } from './typecheckDiagnostics.mjs';
import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
// Executor options belong to its existing placement/admission policy, never
// to TypeScript. Keep the controller's explicit local-compilation guard there.
const executorArgs = [];
if (args[0] === '--local') {
  executorArgs.push(args.shift());
  if (args[0] === '--allow-local-compilation') executorArgs.push(args.shift());
}
let coverageBaseline;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--verifyProjectCoverage') continue;
  coverageBaseline = args[index + 1];
  if (!coverageBaseline || coverageBaseline.startsWith('-')) {
    process.stderr.write('--verifyProjectCoverage requires a baseline tsconfig path\n');
    process.exit(1);
  }
  args.splice(index, 2);
  index -= 1;
}

// Plugin SDK's finite task delegates to its existing prepared compiler script.
const lifecycleTask = process.env.npm_lifecycle_event === 'typecheck:tests:prepared'
  ? 'typecheck:finite' : process.env.npm_lifecycle_event;
const finiteTask = [lifecycleTask, process.env.TURBO_TASK_ID?.split('#').at(-1)]
  .find((task) => task === 'typecheck:finite' || task === 'typecheck:source:finite');
if (finiteTask && process.env.HAPPIER_TYPECHECK_DISPATCHED !== '1') {
  process.stderr.write(`run \`pnpm run typecheck\` (routed) instead of \`${finiteTask}\`\n`);
  process.exit(1);
}

function compilerProjects(args) {
  const projects = [];
  const sharedArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-p' || arg === '--project') {
      const project = args[++index];
      // Leave malformed native arguments intact for the compiler's diagnostic.
      if (!project || project.startsWith('-')) return [{ args, project: null }];
      projects.push(project);
    } else if (arg.startsWith('--project=')) {
      projects.push(arg.slice('--project='.length));
    } else {
      sharedArgs.push(arg);
    }
  }
  if (projects.length <= 1) return [{ args, project: projects[0] ?? null }];
  return projects.map((project) => ({ args: [...sharedArgs, '--project', project], project }));
}

async function runCompiler(invocation, project, isCancelled, captureDiagnostics = false) {
  const options = { ownedProcessGroup: true, cwd: process.cwd(), stdio: 'inherit', env: process.env };
  const diagnosticReportDir = process.env.HAPPIER_TYPECHECK_REPORT_DIR;
  const capture = Boolean(diagnosticReportDir) || captureDiagnostics;
  const compilerArgs = [...invocation.argsPrefix, ...project.args, ...(invocation.argsSuffix ?? []), ...(capture ? ['--pretty', 'false'] : [])];
  const execute = async (command, args) => {
    if (!capture) return await runCommand(command, args, options);
    const child = spawnForegroundCommand(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => { stdout.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr.push(chunk); process.stderr.write(chunk); });
    const result = await new Promise(resolveResult => {
      child.once('error', error => resolveResult({ status: null, signal: null, error }));
      child.once('close', (status, signal) => resolveResult({ status, signal }));
    });
    return { ...result, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  };
  const publish = async result => {
    if (diagnosticReportDir) await writeJsonAtomic(resolve(diagnosticReportDir, `${randomUUID()}.json`), {
      cwd: process.cwd(), project: project.authoredProject ?? project.project,
      compiler: invocation.compilerPath,
      status: result.status, signal: result.signal,
      ...(result.error ? { error: { message: result.error.message, code: result.error.code } } : {}),
      stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    });
    return result;
  };
  if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS !== '1') {
    return await publish(await execute(invocation.command, compilerArgs));
  }

  // A private result file keeps binary terminal streams inherited and preserves
  // native spawn failures, numeric statuses and signals as distinct outcomes.
  const reportDir = await mkdtemp(resolve(tmpdir(), 'happier-typescript-rss-'));
  const reportPath = resolve(reportDir, 'result.json');
  try {
    if (isCancelled()) return { status: 0, signal: null };
    const adapterResult = await execute('python3', [resolve(scriptDir, 'measureTypeScriptCompiler.py'), reportPath, invocation.command, ...compilerArgs]);
    if (adapterResult.error || adapterResult.signal || adapterResult.status !== 0) return await publish(adapterResult);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.error) return await publish({ ...adapterResult, status: null, signal: null, error: Object.assign(new Error(report.error.message), { code: report.error.code }) });
    const exited = Number.isInteger(report.status) && report.status >= 0 && report.status <= 255 && report.signal === null;
    const signalled = report.status === null && typeof report.signal === 'string' && constants.signals[report.signal] !== undefined;
    if ((!exited && !signalled) || !Number.isInteger(report.maxRssKiB) || report.maxRssKiB < 0) {
      throw new Error('Invalid TypeScript compiler measurement result');
    }
    process.stderr.write(`[typescript] ${JSON.stringify({ project: project.project, metric: 'wait4-child-max-rss', ...report })}\n`);
    return await publish({ ...adapterResult, status: report.status, signal: report.signal });
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

// Automatic command placement is POSIX-only; Windows compilation stays local.
if (process.platform !== 'win32' && (executorArgs.length > 0 || shouldRouteTypeScriptCliThroughHstack({ args, env: process.env }))) {
  const launcher = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
  const scriptFromWorkspace = relative(process.cwd(), fileURLToPath(import.meta.url));
  const routedArgs = coverageBaseline ? ['--verifyProjectCoverage', coverageBaseline, ...args] : args;
  const routedResult = await runCommand(launcher, [...executorArgs, '--', 'node', scriptFromWorkspace, ...routedArgs], {
    ownedProcessGroup: true,
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  exitWithCommandResult(routedResult);
} else {
  let result = { status: 0, signal: null };
  let cancelled = false;
  const observeCancellation = () => { cancelled = true; };
  const cancellationSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // Forwarding and reaping stay with runCommand. A graceful native exit must
  // still stop the batch after the user cancels the containing operation.
  for (const signal of cancellationSignals) process.on(signal, observeCancellation);
  try {
    const projects = compilerProjects(args).map(project => ({ ...project, authoredProject: project.project, authoredArgs: project.args }));
    const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
    const uiInventory = cancelled ? undefined : await prepareUiTypecheckProjects(projects, process.cwd());
    const { prepareCliTypecheckProjects } = await import('../../apps/cli/scripts/deriveTypecheckProjects.mjs');
    const inventory = cancelled ? undefined : await prepareCliTypecheckProjects(projects, process.cwd());
    if (coverageBaseline && !cancelled) await verifyTypeScriptProjectCoverage({ baselinePath: coverageBaseline,
      baseline: (inventory ?? uiInventory)?.baseline,
      projectPaths: projects.map(({ project }) => project).filter(Boolean), cwd: process.cwd() });
    const producers = cancelled ? [] : await prepareReferencedTypecheckDeclarations(projects, process.cwd(), inventory);
    let diagnostics;
    if (!cancelled) {
      try { diagnostics = await createTypecheckDiagnosticRun({ projects }); }
      catch { process.stderr.write('[typecheck-delta] unavailable: initialization failed; compiler verdict unchanged\n'); }
    }
    for (const project of [...producers, ...projects]) {
      if (cancelled) break;
      // Output paths belong to the authored config; finite projections inherit
      // them through extends and only replace membership and references.
      prepareTypeScriptProjectBuildFromArgs(project.authoredArgs, { cwd: process.cwd() });
      // Declaration preparation is a UI workload. Expose its actual project
      // to the existing classifier instead of charging it to the CLI consumer.
      const invocation = resolveTypeScriptCliInvocation({ args: project.args, admissionArgs: project.authoredArgs, repoRoot,
        workspaceDir: process.cwd(), processExecPath: process.execPath, prepareWorkspaceDeclarations: false });
      const projectResult = await runCompiler(invocation, project, () => cancelled, diagnostics?.enabled);
      diagnostics?.record(project, projectResult);
      if (projectResult.error || projectResult.signal || projectResult.status == null) {
        result = projectResult;
        break;
      }
      if (projectResult.status !== 0) {
        result = projectResult;
        if (producers.includes(project)) break;
      }
    }
    if (!cancelled && diagnostics?.enabled) {
      try {
        const reports = await diagnostics.publish();
        for (const report of reports) process.stderr.write(`[typecheck-delta] ${report.package}: ${report.baseline ? `${report.newInTouchedPaths} new in touched paths` : 'baseline unavailable (first run or changed project set)'}; ${report.total} diagnostics, ${report.globalDiagnostics} global; ${report.path}\n`);
        if (!reports.length) process.stderr.write('[typecheck-delta] unavailable: no complete diagnostic result; previous baseline retained\n');
      } catch {
        process.stderr.write('[typecheck-delta] unavailable: snapshot failed; compiler verdict unchanged\n');
      }
    }
    if (!cancelled && !result.error && !result.signal && Number.isInteger(result.status) && result.status > 0) {
      // Diagnose on the worker only after failure, never prepare or retry. A
      // broken/moving record must not replace the compiler's terminal result.
      try {
        const { findFirstNoncurrentWorkspaceDependency } = await import('./ensureWorkspacePackagesBuilt.mjs');
        const producer = cancelled ? null : await findFirstNoncurrentWorkspaceDependency(process.cwd());
        if (producer && !cancelled) process.stderr.write(`${producer} declarations are older than its source; rebuild: ./apps/stack/bin/hstack-exec -- pnpm run build:packages ${producer}\n`);
      } catch {
        // This optional hint cannot turn an inspection failure into a verdict.
      }
    }
  } finally {
    for (const signal of cancellationSignals) process.off(signal, observeCancellation);
  }
  exitWithCommandResult(result);
}
