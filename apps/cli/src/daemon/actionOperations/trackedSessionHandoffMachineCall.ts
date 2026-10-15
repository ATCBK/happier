import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';

export function buildTrackedSessionHandoffMachineCall<T extends Readonly<{ method: string }>>(
  input: T,
): T & Readonly<{ timeoutMs?: number }> {
  return input.method === RPC_METHODS.SPAWN_HAPPY_SESSION
    ? { ...input, timeoutMs: resolveSessionStartupTimeoutMs() }
    : input;
}
