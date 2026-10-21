import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { readSessionParts, SessionPartsHttpError, resetSessionPartsReadsForTests } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';

type SessionByIdRequest = (path: string, init: RequestInit) => Promise<Response>;
export type SessionByIdHttpRead = Readonly<{ ok: boolean; status: number; body: unknown;
  turns?: Readonly<{ status: number; body: unknown }> }>;

export type SessionByIdHttpReadParams = Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
  request: SessionByIdRequest;
  readTransport?: CapturedServerReadTransport;
  timeoutMs?: number;
  accessProjectionVersion?: 1;
  projection?: 'detail' | 'turns' | 'snapshot';
  signal?: AbortSignal;
  retry?: 'none';
  fresh?: boolean;
}>;

/** Parsed transport observations only; callers retain access, crypto and publication admission. */
export async function readSessionByIdHttp(params: SessionByIdHttpReadParams): Promise<SessionByIdHttpRead> {
  const projection = params.projection ?? 'detail';
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs : null;
  const deadline = timeoutMs === null ? null : new AbortController();
  const timeoutId = deadline && timeoutMs !== null ? setTimeout(() => deadline.abort(), timeoutMs) : null;
  const cancellation = mergeAbortSignals([deadline?.signal, params.signal]);
  try {
    if (params.readTransport && readCredentialAuthorityKind(params.token) !== 'api_token') {
      try {
        const row = (await readSessionParts({ request: params.request, readTransport: params.readTransport,
          sessionIds: [params.sessionId], includeSnapshot: true, includeTurns: projection !== 'detail',
          includeMessages: false, accessProjectionVersion: params.accessProjectionVersion,
          signal: cancellation.signal, fresh: params.fresh, retry: params.retry, assertCurrent: () => {} })).get(params.sessionId);
        const part = projection === 'turns' ? row?.turns ?? (row?.detail?.status !== 200 ? row?.detail : undefined) : row?.detail;
        if (!part) throw new Error('Incomplete Session parts response');
        return { ok: part.status === 200, status: part.status, body: part.body,
          ...(projection === 'snapshot' && row?.turns ? { turns: row.turns } : {}) };
      } catch (error) {
        if (error instanceof SessionPartsHttpError) return { ok: false, status: error.httpStatus, body: error.body };
        throw error;
      }
    }
    // Restricted/opaque requests do not establish a neutral Account carrier.
    // Give each its own invocation of the same cancellation mechanism, never a shared identity map.
    return await createScopedResolutionSingleFlight<SessionByIdHttpRead>().run('legacy', async signal => {
      const path = projection === 'turns' ? `/v1/sessions/${encodeURIComponent(params.sessionId)}/turns`
        : `/v2/sessions/${encodeURIComponent(params.sessionId)}${params.accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`;
      const init = { method: 'GET', headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' }, signal };
      const consume = async (response: Response): Promise<SessionByIdHttpRead> => {
        const body = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, body };
      };
      return await consume(await params.request(path, init));
    }, { signal: cancellation.signal });
  } finally {
    cancellation.dispose();
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export function resetSessionByIdHttpReadsForTests(): void { resetSessionPartsReadsForTests(); }
