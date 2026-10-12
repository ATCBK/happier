import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithCommandResult, runCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';

import { prepareTypeScriptProjectBuildFromArgs } from './prepareTypeScriptProjectBuild.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import {
  resolveTypeScriptCliInvocation,
  shouldRouteTypeScriptCliThroughHstack,
} from './resolveTypeScriptCliInvocation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);

// Plugin SDK's finite task delegates to its existing prepared compiler script.
const lifecycleTask = process.env.npm_lifecycle_event === 'typecheck:tests:prepared'
  ? 'typecheck:finite' : process.env.npm_lifecycle_event;
const finiteTask = [lifecycleTask, process.env.TURBO_TASK_ID?.split('#').at(-1)]
  .find((task) => task === 'typecheck:finite' || task === 'typecheck:source:finite');
if (finiteTask && process.env.HAPPIER_TYPECHECK_DISPATCHED !== '1') {
  process.stderr.write(`run \`yarn typecheck\` (routed) instead of \`${finiteTask}\`\n`);
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

async function prepareReferencedUiDeclarations(projects, cwd) {
  const consumer = projects.find(({ project }) => project && basename(project) === 'tsconfig.test.json'
    && basename(dirname(resolve(cwd, project))) === 'cli');
  if (!consumer) return [];
  const authored = resolve(cwd, consumer.project);
  const config = JSON.parse(await readFile(authored, 'utf8'));
  const reference = config.references?.find(({ path }) => basename(path) === 'tsconfig.source.json'
    && basename(dirname(resolve(dirname(authored), path))) === 'ui');
  if (!reference) return [];
  const uiDir = dirname(resolve(dirname(authored), reference.path));
  const producers = ['foundation', 'core', 'source', 'test'].map(name => {
    const args = ['--singleThreaded', '--project', resolve(uiDir, `tsconfig.${name}.json`)];
    return { project: resolve(uiDir, `tsconfig.${name}.json`), args, authoredArgs: args };
  });
  const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
  await prepareUiTypecheckProjects(producers, cwd);
  const target = resolve(dirname(authored), 'node_modules/.cache/tsc/tsconfig.test.json');
  await mkdir(dirname(target), { recursive: true });
  await writeJsonAtomic(target, {
    extends: authored,
    references: config.references.map(value => ({ ...value,
      path: value === reference ? producers[2].project : resolve(dirname(authored), value.path),
    })),
  });
  consumer.args = consumer.args.map((arg, index) => ['--project', '-p'].includes(consumer.args[index - 1])
    ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
  consumer.project = target;
  return producers.slice(0, 3);
}

async function runCompiler(invocation, project, isCancelled) {
  const options = { ownedProcessGroup: true, cwd: process.cwd(), stdio: 'inherit', env: process.env };
  const compilerArgs = [...invocation.argsPrefix, ...project.args];
  if (process.platform !== 'linux' || process.env.CI !== 'true' || process.env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS !== '1') {
    return await runCommand(invocation.command, compilerArgs, options);
  }

  // A private result file keeps binary terminal streams inherited and preserves
  // native spawn failures, numeric statuses and signals as distinct outcomes.
  const reportDir = await mkdtemp(resolve(tmpdir(), 'happier-typescript-rss-'));
  const reportPath = resolve(reportDir, 'result.json');
  try {
    if (isCancelled()) return { status: 0, signal: null };
    const adapterResult = await runCommand('python3', [resolve(scriptDir, 'measureTypeScriptCompiler.py'), reportPath, invocation.command, ...compilerArgs], options);
    if (adapterResult.error || adapterResult.signal || adapterResult.status !== 0) return adapterResult;
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.error) return { status: null, signal: null, error: Object.assign(new Error(report.error.message), { code: report.error.code }) };
    const exited = Number.isInteger(report.status) && report.status >= 0 && report.status <= 255 && report.signal === null;
    const signalled = report.status === null && typeof report.signal === 'string' && constants.signals[report.signal] !== undefined;
    if ((!exited && !signalled) || !Number.isInteger(report.maxRssKiB) || report.maxRssKiB < 0) {
      throw new Error('Invalid TypeScript compiler measurement result');
    }
    process.stderr.write(`[typescript] ${JSON.stringify({ project: project.project, metric: 'wait4-child-max-rss', ...report })}\n`);
    return { status: report.status, signal: report.signal };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

// Automatic command placement is POSIX-only; Windows compilation stays local.
if (process.platform !== 'win32' && shouldRouteTypeScriptCliThroughHstack({ args, env: process.env })) {
  const launcher = resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
  const scriptFromWorkspace = relative(process.cwd(), fileURLToPath(import.meta.url));
  const routedResult = await runCommand(launcher, ['--', 'node', scriptFromWorkspace, ...args], {
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
    const projects = compilerProjects(args).map(project => ({ ...project, authoredArgs: project.args }));
    if (projects.length === 4) {
      const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
      if (!cancelled) await prepareUiTypecheckProjects(projects, process.cwd());
    }
    const producers = cancelled ? [] : await prepareReferencedUiDeclarations(projects, process.cwd());
    for (const project of [...producers, ...projects]) {
      if (cancelled) break;
      // Output paths belong to the authored config; finite projections inherit
      // them through extends and only replace membership and references.
      prepareTypeScriptProjectBuildFromArgs(project.authoredArgs, { cwd: process.cwd() });
      // Declaration preparation is a UI workload. Expose its actual project
      // to the existing classifier instead of charging it to the CLI consumer.
      const invocation = resolveTypeScriptCliInvocation({ args: project.args, repoRoot,
        workspaceDir: process.cwd(), processExecPath: process.execPath });
      const projectResult = await runCompiler(invocation, project, () => cancelled);
      if (projectResult.error || projectResult.signal || projectResult.status == null) {
        result = projectResult;
        break;
      }
      if (projectResult.status !== 0) {
        result = projectResult;
        if (producers.includes(project)) break;
      }
    }
  } finally {
    for (const signal of cancellationSignals) process.off(signal, observeCancellation);
  }
  exitWithCommandResult(result);
}
