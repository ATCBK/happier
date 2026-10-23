import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { parseProcessOwnerTag } from '@/processes/ownerTag';
import { spawnBackgroundServiceProcessChannel, type BackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';
import { createBackgroundServiceProcessExecution } from './backgroundServiceProcessExecution';
import { createBackgroundServiceRunnerHost } from './backgroundServices';

const { missingWindowsHelper } = vi.hoisted(() => ({ missingWindowsHelper: { value: false } }));
// Only the packaged-helper filesystem boundary is denied in the Windows refusal case.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: ((path) => missingWindowsHelper.value
    && String(path).endsWith('happier-process-custody.exe') ? false : actual.existsSync(path)) satisfies typeof actual.existsSync };
});

describe('background service process channel', () => {
  const envScope = createSpawnHappyCliEnvScope();
  const channels: BackgroundServiceProcessChannel[] = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  afterEach(async () => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    missingWindowsHelper.value = false;
    await Promise.all(channels.splice(0).map(channel => channel.terminate()));
    envScope.restore();
  });

  async function withWorker(script: string, run: (channel: BackgroundServiceProcessChannel) => Promise<void>) {
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      writeFileSync(entrypoint, script);
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
        HAPPIER_MANAGED_NODE_BIN: process.execPath,
      });
      const channel = await spawnBackgroundServiceProcessChannel({ serviceId: 'indexer', pluginId: 'external' });
      channels.push(channel);
      await run(channel);
    });
  }

  it.skipIf(process.platform !== 'linux')('exchanges bytes with the real CLI child and closes only after physical exit', async () => {
    await withWorker(`
      process.stdout.write(JSON.stringify({pid: process.pid, owner: process.env.HAPPIER_PROCESS_OWNER, args: process.argv.slice(2)}) + '\\n');
      process.stdin.on('data', chunk => process.stdout.write(chunk));
      process.stdin.on('end', () => setImmediate(() => process.exit(0)));
    `, async (channel) => {
      let output = Buffer.alloc(0);
      let changed: (() => void) | undefined;
      channel.onData(chunk => { output = Buffer.concat([output, chunk]); changed?.(); });
      while (!output.includes(10)) await new Promise<void>(resolve => { changed = resolve; });
      const newline = output.indexOf(10);
      const ready = JSON.parse(output.subarray(0, newline).toString('utf8'));
      expect(ready.pid).toBe(channel.pid);
      expect(ready.pid).not.toBe(process.pid);
      expect(ready.args).toEqual(['daemon', 'background-service-worker']);
      expect(parseProcessOwnerTag(ready.owner)?.owner).toMatchObject({ kind: 'service', serviceId: 'indexer' });
      const frame = Buffer.from([0, 255, 10, 128]);
      channel.send(frame);
      while (output.length < newline + 1 + frame.length) await new Promise<void>(resolve => { changed = resolve; });
      expect(output.subarray(newline + 1)).toEqual(frame);
      await channel.close();
      await expect(channel.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
      expect(() => channel.send(frame)).toThrow();
    });
  });

  it.skipIf(process.platform !== 'linux')('cleans a descendant after an unexpected worker root exit', async () => {
    await withWorker(`
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      process.stdout.write(String(child.pid) + '\\n');
      process.stdin.resume();
      process.stdin.on('data', () => process.exit(23));
    `, async (channel) => {
      let output = '';
      let ready: (() => void) | undefined;
      channel.onData(chunk => { output += chunk.toString('utf8'); if (output.includes('\n')) ready?.(); });
      if (!output.includes('\n')) await new Promise<void>(resolve => { ready = resolve; });
      const descendant = Number(output.trim());
      expect(descendant).toBeGreaterThan(1);
      process.kill(descendant, 0);
      channel.send(Buffer.from('exit'));
      await expect(channel.waitForTermination()).resolves.toEqual({ type: 'exited', code: 23 });
      const { readProcessCensus } = await import('@/processes/census/processCensus');
      const census = await readProcessCensus({ freshness: 'fresh', pids: [descendant], fields: [] });
      expect(census.status).toBe('ok');
      if (census.status === 'ok') expect(census.rows.find(row => row.pid === descendant)?.state ?? 'gone').toMatch(/zombie|gone/);
    });
  });

  it.skipIf(process.platform !== 'linux')('reports a failed graceful worker shutdown after physical cleanup', async () => {
    await withWorker(`
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(23));
    `, async (channel) => {
      await expect(channel.close()).rejects.toMatchObject({ code: 'background_service_process_shutdown_failed' });
    });
  });

  it.skipIf(process.platform !== 'linux').each([
    { phase: 'run', code: 'background_service_process_exited' },
    { phase: 'graceful shutdown', code: 'background_service_process_shutdown_failed' },
  ])('releases a physically cleaned $phase failure and admits a fresh demanded child', async ({ phase, code }) => {
    await withWorker(`
      let buffered = Buffer.alloc(0);
      let birth;
      let failOnStop;
      const send = value => {
        const body = Buffer.from(JSON.stringify(value));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        process.stdout.write(Buffer.concat([header, body]));
      };
      process.stdin.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
          const length = buffered.readUInt32BE(0);
          const message = JSON.parse(buffered.subarray(4, length + 4).toString());
          buffered = buffered.subarray(length + 4);
          if (message.kind === 'initialize') {
            birth = message.bootstrap.payload.birth;
            failOnStop = message.bootstrap.payload.failOnStop;
            send({kind:'ready', pid:process.pid});
          } else if (message.kind === 'run') {
            if (birth === 1 && !failOnStop) process.exit(23);
            send({kind:'settled', id:message.id});
          } else if (message.kind === 'stop') process.exit(birth === 1 && failOnStop ? 23 : 0);
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `, async firstChannel => {
      let births = 0;
      const host = createBackgroundServiceRunnerHost({
        registrations: [{
          owner: { kind: 'host', serviceId: 'indexer' }, occurrenceId: 'test', localId: 'index',
          placement: 'process', activation: 'demand', async runner() {},
          createExecution() {
            const birth = ++births;
            return createBackgroundServiceProcessExecution({
              bootstrap: { entry: 'host', entryId: 'memory-indexer', payload: { birth, failOnStop: phase === 'graceful shutdown' } },
              serviceId: 'indexer', services: {},
              spawnChannel: async () => {
                if (birth === 1) return firstChannel;
                const channel = await spawnBackgroundServiceProcessChannel({ serviceId: 'indexer' });
                channels.push(channel);
                return channel;
              },
            });
          },
        }],
        createContext() { throw new Error('Host process demands do not construct plugin context'); },
      });
      try {
        await expect(host.demand({ serviceId: 'indexer' }).settlement).rejects.toMatchObject({ code });
        await expect(host.demand({ serviceId: 'indexer' }).settlement).resolves.toBeUndefined();
        expect(births).toBe(2);
      } finally { await host.dispose(); }
    });
  });

  it.skipIf(process.platform !== 'linux')('terminates the retained tree including a descendant in another process group', async () => {
    await withWorker(`
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore', detached:true});
      process.stdout.write(String(child.pid) + '\\n');
      process.stdin.resume();
    `, async (channel) => {
      let output = '';
      let ready: (() => void) | undefined;
      channel.onData(chunk => { output += chunk.toString('utf8'); if (output.includes('\n')) ready?.(); });
      if (!output.includes('\n')) await new Promise<void>(resolve => { ready = resolve; });
      const descendant = Number(output.trim());
      process.kill(descendant, 0);
      await channel.terminate();
      const { readProcessCensus } = await import('@/processes/census/processCensus');
      const census = await readProcessCensus({ freshness: 'fresh', pids: [descendant], fields: [] });
      expect(census.status).toBe('ok');
      if (census.status === 'ok') expect(census.rows.find(row => row.pid === descendant)?.state ?? 'gone').toMatch(/zombie|gone/);
    });
  });

  it('refuses Windows launch when the shared custody helper is absent', async () => {
    if (!platform) throw new Error('Expected configurable process platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    missingWindowsHelper.value = true;
    await expect(spawnBackgroundServiceProcessChannel({ serviceId: 'indexer' })).rejects.toMatchObject({
      code: 'background_service_process_custody_unavailable',
    });
  });
});
