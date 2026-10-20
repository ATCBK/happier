import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseLogRecords } from './analysis.mjs';
import { isPidOwnedByStack } from '../utils/proc/ownership.mjs';

const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

export function processSnapshot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const fields = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pcpu=,rss=,time='], { encoding: 'utf8' }).trim().split(/\s+/);
    const clock = fields[3].split(/[:-]/).map(Number);
    let cpuSeconds = clock.pop() + clock.pop() * 60;
    if (clock.length) cpuSeconds += clock.pop() * 3600;
    if (clock.length) cpuSeconds += clock.pop() * 86400;
    return { pid, lifetimeCpuPercent: Number(fields[1]), rssBytes: Number(fields[2]) * 1024, cpuSeconds };
  } catch { return null; }
}

export async function snapshotHost({ stackBaseDir, stack, startMs, endMs }) {
  const root = resolve(stackBaseDir);
  if (basename(root) !== stack || !/^agent-qa-[a-zA-Z0-9._-]+$/.test(stack)) throw new Error('Snapshot requires its exact named QA stack directory');
  const state = readJson(join(root, 'stack.runtime.json'));
  const sampledAtMs = Date.now();
  const serverPid = state?.processes?.serverPid, daemonPid = state?.processes?.daemonPid;
  const ownedProcess = async pid => Number.isSafeInteger(pid) && await isPidOwnedByStack(pid, {
    stackName: stack, envPath: join(root, 'env'), cliHomeDir: join(root, 'cli'),
  }) ? processSnapshot(pid) : null;
  const server = await ownedProcess(serverPid), daemon = await ownedProcess(daemonPid);
  const files = [];
  for (const directory of [join(root, 'logs'), join(root, 'cli', 'logs')]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!/^(?:server\.log(?:\.\d+)?|.*-daemon\.log)$/.test(name)) continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.mtimeMs >= startMs) files.push(path);
    }
  }
  const records = [];
  if (endMs) for (const path of files) {
    let date = basename(path).match(/^(\d{4}-\d\d-\d\d)/)?.[1] ?? new Date(startMs).toISOString().slice(0, 10);
    let previousClock = '';
    // Stream lines and retain only diagnostics; raw request/SQL/auth bodies
    // never leave this process or get copied to an evidence directory.
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let block = '';
    const flush = () => {
      for (const record of parseLogRecords(block, { date, timezoneOffsetMinutes: new Date().getTimezoneOffset() })) if (record.atMs >= startMs && record.atMs <= endMs) records.push({ ...record, file: path,
        role: basename(path).endsWith('-daemon.log') ? 'daemon' : 'server' });
      block = '';
    };
    for await (const line of lines) {
      if (/^\[server\] \[\d{4}-|^\{.*"time":|^\[\d\d:/.test(line)) {
        flush();
        const clock = line.match(/^\[(\d\d:\d\d:\d\d)/)?.[1];
        if (clock) {
          if (previousClock && clock < previousClock) date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
          previousClock = clock;
        }
      }
      block += `${line}\n`;
    }
    flush();
  }
  return { atMs: sampledAtMs, host: os.hostname(), platform: process.platform, arch: process.arch,
    cpus: os.cpus().length, load: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    identity: { mode: state?.runtimeMode, sourceUi: state?.sourceUi, uiDir: state?.sourceUiLaunch?.uiDir,
      roles: Object.fromEntries(['server', 'daemon'].map(role => [role, { selected: state?.sourceRuntimeIdentities?.[role]?.selected, loaded: state?.sourceRuntimeIdentities?.[role]?.loaded }])), startedAt: state?.startedAt },
    server, daemon,
    logs: { files, records } };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const result = await snapshotHost(JSON.parse(process.argv[2]));
    console.log(`HAPPIER_PERF_HOST=${JSON.stringify(result)}`);
  } catch { console.error('Host snapshot failed; raw diagnostics suppressed'); process.exitCode = 1; }
}
