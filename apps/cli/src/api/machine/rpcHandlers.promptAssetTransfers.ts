import { FoundSkillDownloadRequestV1Schema } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { configuration } from '@/configuration';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { resolveFoundSkillDownloadSource, type FoundSkillReadOptions } from '@/prompts/skills/native/resolveFoundSkillDownloadSource';

import type { RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineDownloadTransferRpcHandlers } from './transfers/registerMachineDownloadTransferRpcHandlers';

export type MachinePromptAssetTransferRpcRegistration = Readonly<{
  transferSessionStore: TransferSessionStore;
  downloadStore: TransferSessionStore;
  dispose: () => Promise<void>;
}>;

export function registerMachinePromptAssetTransferRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  foundSkills?: Omit<FoundSkillReadOptions, 'signal'>;
}>): MachinePromptAssetTransferRpcRegistration {
  const store = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerMachineDownloadTransferRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    store,
    methods: {
      init: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
    },
    parseRequest: (data) => {
      const parsed = FoundSkillDownloadRequestV1Schema.safeParse(data);
      return parsed.success ? parsed.data : null;
    },
    resolveSource: async (request, context) => {
      const source = await resolveFoundSkillDownloadSource({
        ...params.foundSkills,
        ...(context ? { signal: context.signal } : {}),
        request,
      });
      if (!source.success) {
        return source;
      }

      return {
        source: source.source,
        diagnosticContext: {
          transferKind: 'prompt_asset',
        },
      };
    },
    initFailureMessage: 'Found skill download init failed',
  });


  return {
    transferSessionStore: store,
    downloadStore: store,
    dispose: async () => {
      await store.dispose();
    },
  };
}
