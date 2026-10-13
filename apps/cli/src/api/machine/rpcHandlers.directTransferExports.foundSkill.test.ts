import { expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerMachineDirectTransferExportRpcHandlers } from './rpcHandlers.directTransferExports';
import { resolveFoundSkillDownloadSource } from '@/prompts/skills/native/resolveFoundSkillDownloadSource';

it('admits a Found path for the existing direct carrier and rejects retired adapter coordinates', async () => {
  const handlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
    // The transport presents unknown input; the real handler owns decoding.
    handlers.set(method, data => handler(data as TRequest));
  } };
  registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: registrar,
    prepareExportSession: async request => {
      expect(request).toEqual({ t: 'prompt_asset_download_v1', path: '/project/.skills/writer' });
      return { transferId: 'found-transfer', expiresAt: 5000, endpointCandidates: [] };
    } });
  const invoke = handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)!;
  expect(await invoke({ t: 'prompt_asset_download_v1', path: '/project/.skills/writer' })).toMatchObject({ success: true, transferId: 'found-transfer' });
  expect(await invoke({ t: 'prompt_asset_download_v1', assetTypeId: 'agents.skill', scope: 'user', externalRef: { skillName: 'writer' } }))
    .toMatchObject({ success: false });
});

it('preserves a scanner-backed not_found result through the direct export failure envelope', async () => {
  const handlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
    // The transport presents unknown input; the real handler owns decoding.
    handlers.set(method, data => handler(data as TRequest));
  } };
  registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: registrar,
    prepareExportSession: async request => {
      if (request.t !== 'prompt_asset_download_v1') throw new Error('Wrong transfer kind');
      const result = await resolveFoundSkillDownloadSource({ request, agents: [] });
      if (!result.success) throw Object.assign(new Error(result.error), { code: result.code });
      throw new Error('Unexpected source');
    } });
  const invoke = handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)!;
  expect(await invoke({ t: 'prompt_asset_download_v1', path: '/unscanned/skill' })).toEqual({ success: false, error: 'not_found', code: 'not_found' });
});
