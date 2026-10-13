import { RegistryDownloadRequestV1Schema,type createRegistryHostV1 } from '@happier-dev/protocol/registries';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { TransferSessionStore } from '@happier-dev/transfers/node';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { resolveRegistryItemDownloadSource } from '@/registries/registryTransferPayload';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '../rpc/types';
import { registerMachineDownloadTransferRpcHandlers } from './transfers/registerMachineDownloadTransferRpcHandlers';
export type MachineRegistryTransferRpcRegistration=Readonly<{transferSessionStore:TransferSessionStore;downloadStore:TransferSessionStore;dispose:()=>Promise<void>}>;
export function registerMachineRegistryTransferRpcHandlers(params:Readonly<{rpcHandlerManager:RpcHandlerManager;
  createHost?:(signal?:AbortSignal,context?:RpcHandlerContext)=>ReturnType<typeof createRegistryHostV1>}>):MachineRegistryTransferRpcRegistration {
  const createHost=params.createHost??((signal,context)=>createCliRegistryHostV1({signal,machineAdmission:context?.machineAdmission}));
  const registration=registerMachineDownloadTransferRpcHandlers({rpcHandlerManager:params.rpcHandlerManager,
    methods:{init:RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_INIT,chunk:RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_CHUNK,finalize:RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_FINALIZE,abort:RPC_METHODS.DAEMON_REGISTRIES_DOWNLOAD_ABORT},
    parseRequest:raw=>{const parsed=RegistryDownloadRequestV1Schema.safeParse(raw);return parsed.success?parsed.data:null;},
    resolveSource:(request,context)=>resolveRegistryItemDownloadSource({host:createHost(context?.signal,context),request}),initFailureMessage:'Registry download init failed',
  });
  return {...registration,downloadStore:registration.transferSessionStore};
}
