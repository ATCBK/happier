import { readRpcErrorCode, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

/**
 * The typed code of a thrown RPC failure, or undefined when it carries none. The transport's issuance evidence
 * survives Action serialization: a lost answer stays uncertain (`RPC_OUTCOME_UNKNOWN`) even when cancellation
 * also carries a typed code.
 */
export function readRpcFailureCode(error: unknown): string | undefined {
  return readRpcRequestDisposition(error) === 'outcomeUnknown' ? RPC_ERROR_CODES.OUTCOME_UNKNOWN : readRpcErrorCode(error);
}
