import type { StoredCredentials } from '@/persistence';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type {
    SessionEncryptionContext,
    SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    resolveSessionEncryptionContextFromCredentials,
    resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { type ResolveSessionIdResult, resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { logger } from '@/ui/logger';

export type ResolveSessionTransportContextResult =
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: null;
          mode: 'plain';
      }
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: SessionEncryptionContext;
          mode: 'e2ee';
      }
    | {
          ok: false;
          code:
              | Extract<ResolveSessionIdResult, { ok: false }>['code']
              | 'encryption_material_unavailable';
          candidates?: string[];
          sessionId?: string;
      };

async function fetchSessionTransportRecord(params: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    resolveAuthorizationHeaders?: (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
    }>) => Readonly<Record<string, string>> | null;
    signal?: AbortSignal;
    serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<RawSessionRecord | null> {
    params.signal?.throwIfAborted();
    return await fetchSessionById({
        token: params.credentials.token,
        sessionId: params.sessionId,
        ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
}

export async function resolveSessionTransportContext(params: Readonly<{
    credentials: StoredCredentials;
    idOrPrefix: string;
    resolveAuthorizationHeaders?: (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
    }>) => Readonly<Record<string, string>> | null;
    signal?: AbortSignal;
    /** Snapshot already bound to this exact Home; this owner never probes for one. */
    serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<ResolveSessionTransportContextResult> {
    const resolutionStartedAt = performance.now();
    let phaseStartedAt = resolutionStartedAt;
    const phase = (name: 'account_currentness' | 'session_lookup' | 'session_record' | 'encryption_material', startedAt = phaseStartedAt) => {
        const now = performance.now();
        logger.debug('[SessionTransport] Resolution phase', { phase: name,
            durationMs: Math.round(now - startedAt), elapsedMs: Math.round(now - resolutionStartedAt) });
        phaseStartedAt = now;
    };
    params.signal?.throwIfAborted();
    const currentnessAuthorizationHeaders = params.resolveAuthorizationHeaders?.({
        method: 'GET', path: '/v1/account/encryption/currentness',
    });
    if (params.resolveAuthorizationHeaders && !currentnessAuthorizationHeaders) {
        throw new Error('External Action authorization unavailable');
    }
    const accountEncryptionCurrentnessRead = fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        ...(currentnessAuthorizationHeaders
            ? { authorizationHeaders: currentnessAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    }).then(currentness => { phase('account_currentness', resolutionStartedAt); return currentness; });
    const lookupStartedAt = performance.now();
    const sessionLookup = resolveSessionIdOrPrefix({
        credentials: params.credentials,
        idOrPrefix: params.idOrPrefix,
        ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
        accountEncryptionMode: async () => (await accountEncryptionCurrentnessRead).mode,
    }).then(resolved => { phase('session_lookup', lookupStartedAt); return resolved; });
    // Both reads stay fresh. No transport or encryption material is published
    // until the Account witness and the canonical selector have both settled.
    const [accountEncryptionCurrentness, resolved] = await Promise.all([accountEncryptionCurrentnessRead, sessionLookup]);
    params.signal?.throwIfAborted();
    if (!resolved.ok) {
        return {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
    }

    const rawSessionPromise = resolved.rawSession
        ? Promise.resolve(resolved.rawSession)
        : fetchSessionTransportRecord({
            credentials: params.credentials,
            sessionId: resolved.sessionId,
            ...(params.resolveAuthorizationHeaders
                ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
                : {}),
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
        });
    const rawSession = await rawSessionPromise;
    phase('session_record');
    params.signal?.throwIfAborted();
    if (!rawSession) {
        return {
            ok: false,
            code: 'session_not_found',
            sessionId: resolved.sessionId,
        };
    }

    const mode = resolveSessionStoredContentEncryptionMode(rawSession);
    if (mode === 'plain') {
        return {
            ok: true,
            sessionId: resolved.sessionId,
            rawSession,
            accountEncryptionCurrentness,
            ctx: null,
            mode,
        };
    }
    const ctx = resolveSessionEncryptionContextFromCredentials(
        params.credentials,
        rawSession,
    );
    phase('encryption_material');
    if (!ctx) {
        return {
            ok: false,
            code: 'encryption_material_unavailable',
            sessionId: resolved.sessionId,
        };
    }

    return {
        ok: true,
        sessionId: resolved.sessionId,
        rawSession,
        accountEncryptionCurrentness,
        ctx,
        mode,
    };
}
