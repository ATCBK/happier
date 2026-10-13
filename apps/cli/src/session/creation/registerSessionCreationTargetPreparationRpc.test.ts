import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

import { registerSessionCreationTargetPreparationRpc } from './registerSessionCreationTargetPreparationRpc';

describe('registerSessionCreationTargetPreparationRpc', () => {
  it('binds the narrow preparation contract to the target daemon and forwards cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-test-clean-preparation-'));
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {} });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager });
    const request = SessionCreationTargetPreparationRequestV1Schema.parse({ directory: { kind: 'path', path: directory } });
    const controller = new AbortController();
    try {
      const result = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, request,
        { signal: controller.signal });
      expect(SessionCreationTargetPreparationResultV1Schema.parse(result)).toEqual({
        ok: true, directory, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
      });
      // Check the actual cancellation outcome, rather than a collaborator call.
      const reason = new Error('Caller cancelled preparation');
      controller.abort(reason);
      await expect(rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE, request,
        { signal: controller.signal })).rejects.toBe(reason);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
