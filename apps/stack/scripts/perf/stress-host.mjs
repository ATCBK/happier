import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { processSnapshot } from './host-snapshot.mjs';

const exec = promisify(execFile);
const docker = async args => (await exec('docker', args, { encoding: 'utf8' })).stdout;

/** Adapter to the existing stress target. This observer never starts or stops services. */
export async function createStressHostObserver({ context, inspect, sqlStatements }) {
  if (!/^happier-stress-[a-zA-Z0-9-]+$/.test(context.composeProjectName) || !context.containers.length) {
    throw new Error('Stress observation requires an owned compose topology');
  }
  const inspectContainers = inspect ?? (async () => JSON.parse(await docker(['inspect', ...context.containers.map(container => container.id)])));
  const readStatements = sqlStatements ?? (async () => {
    const value = await docker(['exec', context.postgresContainerId, 'psql', '-U', 'stress', '-d', 'stressdb', '-v', 'ON_ERROR_STOP=1', '-At', '-c',
      "SELECT json_build_object('calls', (SELECT COALESCE(sum(calls),0) FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())), 'statsReset', stats_reset, 'dealloc', dealloc) FROM pg_stat_statements_info"]);
    const result = JSON.parse(value.trim());
    if (!Number.isSafeInteger(Number(result.calls)) || Number(result.calls) < 0) throw new Error('Physical SQL statement counter unavailable');
    return { calls: Number(result.calls), statsReset: result.statsReset, dealloc: Number(result.dealloc) };
  });
  let closed = false;
  const sample = async () => {
    if (closed) throw new Error('Stress observer already closed');
    const loaded = await inspectContainers();
    if (loaded.length !== context.containers.length || loaded.some((container, index) =>
      container.Id !== context.containers[index].id || container.Config?.Labels?.['com.docker.compose.project'] !== context.composeProjectName || container.State?.Running !== true)) {
      throw new Error('Stress container ownership or running identity changed');
    }
    const statements = await readStatements();
    const sql = typeof statements === 'number' ? { calls: statements, statsReset: null, dealloc: null } : statements;
    const serverIdentity = loaded.map(container => container.Image).join(',');
    const selected = context.containers.map(container => container.image).join(',');
    if (context.containers.some(container => typeof container.image !== 'string' || !container.image)) throw new Error('Selected stress image identity is missing');
    if (selected !== serverIdentity) throw new Error('Selected stress image identity differs from the loaded image');
    const daemon = context.daemonPid ? processSnapshot(context.daemonPid) : null;
    if (context.daemonPid && !daemon) throw new Error('Owned performance daemon exited');
    return {
      atMs: Date.now(), host: os.hostname(), platform: process.platform, arch: process.arch,
      cpus: os.cpus().length, load: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(),
      identity: { mode: 'stress', sourceUi: 'export', uiDir: context.uiDir,
        composeProjectName: context.composeProjectName,
        roles: { server: { selected, loaded: serverIdentity },
          ...(daemon ? { daemon: { selected: String(context.daemonPid), loaded: String(daemon.pid) } } : {}) } },
      server: { containerIds: loaded.map(container => container.Id), cpuSeconds: null, rssBytes: null }, daemon,
      sqlStatements: sql.calls, sqlStatistics: { statsReset: sql.statsReset, dealloc: sql.dealloc },
      logs: { files: [], records: [] },
      unavailable: ['Container CPU/RSS and request diagnostic spans are not collected by this adapter', ...(daemon ? [] : ['No daemon was started for this journey'])],
    };
  };
  const initial = await sample();
  return { readiness: { initial }, records: [], sample,
    stop: async () => { closed = true; return { status: 'CLOSED', terminal: { atMs: Date.now() } }; } };
}
