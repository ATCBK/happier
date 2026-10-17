import type { RpcHandler, RpcHandlerManagerLike, RpcHandlerRegistrar } from '@/api/rpc/types';

export type SwapAwareRpcHandlerRegistrar = Readonly<{
  registrar: RpcHandlerManagerLike;
  rebindTo: (nextRegistrar: RpcHandlerRegistrar) => void;
}>;

export function createSwapAwareRpcHandlerRegistrar(
  getRegistrar: () => RpcHandlerManagerLike,
): SwapAwareRpcHandlerRegistrar {
  const registeredHandlers = new Map<string, RpcHandler>();

  const registerOn = (registrar: RpcHandlerRegistrar, method: string, handler: RpcHandler): void => {
    registrar.registerHandler(method, handler);
  };

  return {
    registrar: {
      registerHandler(method, handler) {
        registeredHandlers.set(method, handler);
        registerOn(getRegistrar(), method, handler);
      },
      invokeLocal(method, params, options) {
        return getRegistrar().invokeLocal(method, params, options);
      },
    },
    rebindTo(nextRegistrar) {
      for (const [method, handler] of registeredHandlers) {
        registerOn(nextRegistrar, method, handler);
      }
    },
  };
}
