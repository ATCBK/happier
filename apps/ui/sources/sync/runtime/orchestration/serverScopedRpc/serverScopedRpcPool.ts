import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { Encryption, MachineEncryptionContext, MachineEncryptionContextInput } from '@/sync/encryption/encryption';
import { areMachineEncryptionContextInputsEqual, readMachineEncryptionContextInput } from '@/sync/encryption/machineEncryption';
import { MachineKeyBasisStoredReadV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import {
    createNotAuthenticatedError,
    isAuthenticationResponseStatus,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { HappyError } from '@/utils/errors/errors';
import {
    isPlainMachineDataKeyMarker,
    resolvePublishedMachineDataEncryptionKeyV1,
    type ExpectedRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/machines/machineStoredContent';

import { getOrCreateScopedCacheTokenKey, resetScopedCacheTokenKeysForTests } from './scopedCacheTokenKey';
import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';

type MachineContextAuthority = Pick<Encryption, 'captureMachineEncryptionContext' | 'getMachineEncryptionContext'>;

function machineRowTimeoutError() {
    return createRpcCallError({ error: 'Machine row request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' });
}

type MachineInstallationTransportIdentity = Readonly<{
    installationId?: string | null;
    installationPublicKey?: string | null;
}>;

export type ScopedMachineTransport =
    | Readonly<{ mode: 'plain'; context?: MachineEncryptionContext } & MachineInstallationTransportIdentity>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array | null; context?: MachineEncryptionContext } & MachineInstallationTransportIdentity>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineTransportCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = getOrCreateScopedCacheTokenKey(token, readMaxMachineKeyCacheEntriesFromEnv());
    return `${serverId}::${machineId}::${tokenKey}`;
}

type MachineTransportEvidence = Readonly<{
    machine: Parameters<typeof resolvePublishedMachineDataEncryptionKeyV1>[0]['machine'] & MachineInstallationTransportIdentity;
    openedDataEncryptionKey: Uint8Array | null;
    identity: MachineEncryptionContextInput;
    selectedContext?: MachineEncryptionContext;
    metadataVersion?: number;
    daemonStateVersion?: number;
}>;

const machineTransportCache = new Map<string, MachineTransportEvidence>();
const machineTransportResolutions = new Map<string, {
    cacheKey: string;
    timeoutMs: number;
    rowPending: boolean;
    timedOut: boolean;
    result: Promise<MachineTransportEvidence | null>;
}>();

function readMaxMachineKeyCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX ?? '').trim();
    if (!raw) return 256;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 256;
    return Math.max(1, Math.min(10_000, parsed));
}

function getMachineTransportFromCache(cacheKey: string): MachineTransportEvidence | undefined {
    const existing = machineTransportCache.get(cacheKey);
    if (existing === undefined) return undefined;
    // Refresh LRU ordering.
    machineTransportCache.delete(cacheKey);
    machineTransportCache.set(cacheKey, existing);
    return existing;
}

function setMachineTransportCache(cacheKey: string, value: MachineTransportEvidence): void {
    machineTransportCache.set(cacheKey, value);

    const max = readMaxMachineKeyCacheEntriesFromEnv();
    while (machineTransportCache.size > max) {
        const oldest = machineTransportCache.keys().next();
        if (oldest.done) break;
        machineTransportCache.delete(oldest.value);
    }
}

async function fetchMachineTransport(params: Readonly<{
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    serverId: string;
    accountId?: string;
    cacheKey: string;
    encryption?: MachineContextAuthority;
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs: number;
    onRowObserved?: () => void;
    onTimeout?: () => void;
}>): Promise<MachineTransportEvidence | null> {
    const incumbentContext = params.encryption?.getMachineEncryptionContext(params.machineId);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => { params.onTimeout?.(); controller.abort(); }, Math.max(1, params.timeoutMs))
        : null;

    try {
        const request = createServerRequestForExplicitServerScope({
            serverUrl: params.serverUrl,
            token: params.token,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
            timeoutMs: params.timeoutMs,
        });
        const response = await request(`/v1/machines/${encodeURIComponent(params.machineId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) {
            if (isAuthenticationResponseStatus(response.status)) {
                throw createNotAuthenticatedError(response.status);
            }
            if (response.status === 404) return null;
            throw new HappyError(`Machine row request failed (${response.status})`, response.status >= 500 || response.status === 429, {
                status: response.status, kind: response.status >= 500 ? 'server' : 'config',
            });
        }

        const body = await response.json() as {
            machine?: {
                id?: unknown;
                kind?: 'persistent' | 'ephemeral_session_runner';
                installationId?: string | null;
                installationPublicKey?: string | null;
                dataEncryptionKey?: unknown;
                runnerContentKeyBinding?: unknown;
                access?: unknown;
                keyBasis?: unknown;
                metadataVersion?: number;
                daemonStateVersion?: number;
            };
        };
        params.onRowObserved?.();
        const machine = body?.machine;
        if (params.encryption && params.encryption.getMachineEncryptionContext(params.machineId) !== incumbentContext) return null;
        if (normalizeId(machine?.id) !== params.machineId) {
            return null;
        }
        const published = machine?.dataEncryptionKey;
        const input = readMachineEncryptionContextInput(machine ?? {}, params.accountId ?? null);
        const cached = getMachineTransportFromCache(params.cacheKey);
        const basis = MachineKeyBasisStoredReadV1Schema.safeParse(machine?.keyBasis);
        const metadataVersion = basis.success ? basis.data.metadataVersion : machine?.metadataVersion;
        const daemonStateVersion = basis.success ? basis.data.daemonStateVersion : machine?.daemonStateVersion;
        if ((metadataVersion !== undefined && cached?.metadataVersion !== undefined && metadataVersion < cached.metadataVersion)
            || (daemonStateVersion !== undefined && cached?.daemonStateVersion !== undefined && daemonStateVersion < cached.daemonStateVersion)) return null;
        const unchanged = cached && areMachineEncryptionContextInputsEqual(cached.identity, input);
        const identity = unchanged ? cached.identity : input;
        const context = params.encryption?.captureMachineEncryptionContext(
            params.machineId,
            input,
        );
        const selected: MachineTransportEvidence = {
            machine: {
                id: params.machineId, kind: machine?.kind, installationId: machine?.installationId,
                installationPublicKey: machine?.installationPublicKey,
                dataEncryptionKey: published, runnerContentKeyBinding: machine?.runnerContentKeyBinding,
                access: machine?.access,
            },
            identity, metadataVersion, daemonStateVersion,
            selectedContext: context,
            openedDataEncryptionKey: unchanged ? cached.openedDataEncryptionKey : null,
        };
        // Publish selection before opening yields so a changed key/access
        // identity retires pending work, including same-key access withdrawal.
        setMachineTransportCache(params.cacheKey, selected);
        const dataKey = selected.openedDataEncryptionKey ?? (typeof published === 'string'
            && !isPlainMachineDataKeyMarker(published)
            && params.decryptEncryptionKey
            ? await params.decryptEncryptionKey(published)
            : null);
        const current = machineTransportCache.get(params.cacheKey);
        if (context?.isCurrent() === false || current?.identity !== selected.identity) return null;
        // A fresh row with the same key/access identity does not retire an
        // in-flight opening. Keep its newer row/version facts in the cache,
        // while this caller retains its own crypto context for currentness.
        const opened = { ...current, openedDataEncryptionKey: dataKey };
        setMachineTransportCache(params.cacheKey, opened);
        return { ...opened, selectedContext: context };
    } catch (error) {
        // An unavailable transport is not evidence that the Machine has no key.
        if (isTerminalAuthError(error)) throw error;
        if (controller?.signal.aborted) throw machineRowTimeoutError();
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function resolveMachineTransportEvidence(
    params: Parameters<typeof fetchMachineTransport>[0],
    deadlineAt = Date.now() + params.timeoutMs,
): Promise<MachineTransportEvidence | null> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw machineRowTimeoutError();
    const flightKey = `${params.cacheKey}::${params.timeoutMs}`;
    const exact = machineTransportResolutions.get(flightKey);
    const existing = (exact?.timedOut === false ? exact : undefined)
        ?? [...machineTransportResolutions.values()].find(entry => entry.cacheKey === params.cacheKey
            && entry.rowPending && !entry.timedOut);
    if (existing) {
        // Each joiner keeps its own supplied deadline and cannot abort the
        // shared authenticated read when only its own wait expires.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let evidence: MachineTransportEvidence | null;
        try {
            evidence = await Promise.race([existing.result, new Promise<never>((_resolve, reject) => {
                timeoutId = setTimeout(() => reject(machineRowTimeoutError()), remainingMs);
            })]);
        } catch (error) {
            // An earlier caller's timeout cannot decide a later caller while
            // its original budget remains. Other failures are not retried.
            const retryRemainingMs = deadlineAt - Date.now();
            if (existing.timedOut && retryRemainingMs > 0) {
                return await resolveMachineTransportEvidence({ ...params, timeoutMs: retryRemainingMs }, deadlineAt);
            }
            throw error;
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
        return evidence;
    }
    const result = fetchMachineTransport({ ...params, timeoutMs: remainingMs,
        onRowObserved: () => { entry.rowPending = false; }, onTimeout: () => { entry.timedOut = true; } })
        .finally(() => {
            if (machineTransportResolutions.get(flightKey) === entry) machineTransportResolutions.delete(flightKey);
        });
    const entry = { cacheKey: params.cacheKey, timeoutMs: params.timeoutMs, rowPending: true, timedOut: false, result };
    machineTransportResolutions.set(flightKey, entry);
    return await result;
}

export async function resolveScopedMachineTransport(params: Readonly<{
    serverId: string;
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    accountId?: string;
    encryption?: MachineContextAuthority;
    expectedAccountMode?: 'plain' | 'e2ee';
    readAccountMode?: () => Promise<'plain' | 'e2ee'>;
    expectedRunnerBinding?: ExpectedRunnerMachineContentKeyBindingV1;
    trustedMachineKind?: 'ephemeral_session_runner';
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
}>): Promise<ScopedMachineTransport | null> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
    const keyCacheKey = toMachineTransportCacheKey(serverId, machineId, token);
    const incumbentContext = params.encryption?.getMachineEncryptionContext(machineId);
    // Refresh the Home row each call; cached openings are reusable only after
    // that row confirms the exact envelope and authenticated access identity.
    // Remaining RPC budgets vary after context/trust setup. Share a pending
    // row read while preserving each caller's deadline; after a row is observed,
    // a different-budget read stays fresh even while its key open is pending.
    const evidence = await resolveMachineTransportEvidence({
            serverId,
            serverUrl: params.serverUrl,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
            token,
            machineId,
            cacheKey: keyCacheKey,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.encryption ? { encryption: params.encryption } : {}),
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
        });
    if (!evidence) return null;
    const isLocalReadCurrent = () => {
        if (!params.encryption) return true;
        const current = params.encryption.getMachineEncryptionContext(machineId);
        return current === incumbentContext || current === evidence.selectedContext;
    };
    const isEvidenceCurrent = () => machineTransportCache.get(keyCacheKey)?.identity === evidence.identity;
    if (!isEvidenceCurrent() || !isLocalReadCurrent()) return null;
    const expectedAccountMode = params.expectedAccountMode ?? (evidence.machine.access === undefined ? await params.readAccountMode?.() : undefined);
    if (!isEvidenceCurrent() || !isLocalReadCurrent()) return null;
    const resolution = resolvePublishedMachineDataEncryptionKeyV1({
        ...evidence,
        ...(params.accountId ? { viewerAccountId: params.accountId } : {}),
        ...(expectedAccountMode ? { expectedAccountMode } : {}),
        ...(params.expectedRunnerBinding ? { expectedRunnerBinding: params.expectedRunnerBinding } : {}),
        ...(params.trustedMachineKind ? { trustedMachineKind: params.trustedMachineKind } : {}),
    });
    if (resolution.status === 'unavailable') {
        return null;
    }
    const localContext = params.encryption?.captureMachineEncryptionContext(machineId, evidence.identity);
    const context: MachineEncryptionContext = {
        ...evidence.identity,
        isCurrent: () => isEvidenceCurrent() && localContext?.isCurrent() !== false,
    };
    const installation = { installationId: evidence.machine.installationId ?? null,
        installationPublicKey: evidence.machine.installationPublicKey ?? null };
    if (resolution.status === 'legacy') return { mode: 'e2ee', dataKey: null, context, ...installation };
    return resolution.status === 'plain'
        ? { mode: 'plain', context, ...installation }
        : { mode: 'e2ee', dataKey: resolution.dataKey, context, ...installation };
}

export function resetScopedMachineTransportCacheForTests(): void {
    machineTransportCache.clear();
    machineTransportResolutions.clear();
    resetScopedCacheTokenKeysForTests();
}
