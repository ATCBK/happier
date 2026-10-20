import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerMachinePromptAssetTransferRpcHandlers } from '@/api/machine/rpcHandlers.promptAssetTransfers';
import { scanNativeSkillRoots } from '@/prompts/skills/native/scanNativeSkillRoots';
import { createFoundSkillBundleReader } from './foundSkillBundleReader';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-found-reader-')); homes.push(home);
  const path = join(home, '.skills', 'fixture');
  await mkdir(join(path, 'scripts'), { recursive: true });
  await writeFile(join(path, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture\n---\nBody');
  await writeFile(join(path, 'scripts', 'run.sh'), '#!/bin/sh\necho fixture');
  await chmod(join(path, 'scripts', 'run.sh'), 0o755);
  const agents = [{ agentId: 'test.skill-reader', nativeRoots: { user: [['.skills']] } }];
  const scan = await scanNativeSkillRoots({ purpose: 'found', home, agents });
  expect(scan.items).toHaveLength(1);
  const handlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
    // The transport presents unknown input; the real handler owns decoding.
    handlers.set(method, data => handler(data as TRequest));
  } };
  const registration = registerMachinePromptAssetTransferRpcHandlers({ rpcHandlerManager: registrar,
    foundSkills: { home, agents } });
  const invoke = async (_machineId: string, method: string, input: unknown) => await handlers.get(method)!(input);
  return { home, path: scan.items[0]!.path, agents, registration, invoke };
}

it('reads its Home-bound own machine directly and another machine through the registered encrypted transfer', async () => {
  const f = await fixture();
  try {
    const direct = createFoundSkillBundleReader({ machineId: 'local', home: f.home, agents: f.agents,
      machineRPC: async () => { throw new Error('Local read must not open RPC'); } });
    const local = await direct('local', f.path);
    const remote = createFoundSkillBundleReader({ machineId: 'local', machineRPC: f.invoke });
    expect(await remote('remote', f.path)).toEqual(local);
    expect(local.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
    if (process.platform !== 'win32') expect(local.files[1]?.unixMode).toBe(0o755);
    expect(f.registration.downloadStore.listDownloadSessionIds()).toEqual([]);
  } finally { await f.registration.dispose(); }
});

it('aborts an acknowledged remote download when its caller cancels or an encrypted response is malformed', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const cancelled = createFoundSkillBundleReader({ machineId: null, machineRPC: async (machineId, method, input, signal) => {
      const result = await f.invoke(machineId, method, input);
      if (method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK) controller.abort();
      if (method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT) expect(signal).toBeUndefined();
      return result;
    } });
    await expect(cancelled('remote', f.path, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.registration.downloadStore.listDownloadSessionIds()).toEqual([]);
    const malformed = createFoundSkillBundleReader({ machineId: null, machineRPC: async (machineId, method, input) => {
      if (method === RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK) return { success: true, payloadBase64: 'broken', encryptedDataKeyEnvelopeBase64: '', isLast: true };
      return await f.invoke(machineId, method, input);
    } });
    await expect(malformed('remote', f.path)).rejects.toMatchObject({ code: 'invalid_transfer_response' });
    expect(f.registration.downloadStore.listDownloadSessionIds()).toEqual([]);
  } finally { await f.registration.dispose(); }
});
