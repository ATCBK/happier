import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQueryBatchInput, resolveUsageQueryPeriod, usageQueryToAnalyticsRequest, type UsageQuery, type UsageQueryBatchInput } from '@happier-dev/protocol/inputs/usageQuery';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { resolveUsagePageAggregation, resolveUsageQuotaPageAggregation, projectUsageAccountingSnapshotPrices, resolveUsagePageAccountingReads, resolveUsageAccountingAsOfMs, retainAccountingOnReadFailure, retainUsageQueryResultReferences, canRetainUsageReadFailure, UsageQueryBatchResultSchema, type UsageAccountingSourceSnapshot, type UsageHowYouWorkSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQueryBatchResult, type UsageWorkSourceSnapshot, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServicePoolSelectionGetRequestV1Schema, type ConnectedServicePoolSelectionGetRequestV1, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { computePluginUiArtifactSha256Digest } from '@/sync/domains/plugins/ui/artifactIntegrity';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { bindAccountEncryptionObservation, captureAccountEncryptionObservationForHome } from '@/sync/http/accountEncryptionObservationBinding';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { queryUsageAnalytics } from './apiUsage';
import { getAccountEncryptionModeCacheRevision } from './apiAccountEncryptionMode';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import { readMachineControlTargetForSession, resolveMachineControlTargetForSessionFromState, resolveDisplayMachineIdForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds, projectSessionUsageWorkEvidence } from '@/sync/domains/usage/usageWorkEvidence';
import { buildUsageCoachRemedies } from '@/sync/domains/usage/buildUsageCoachRemedies';
import { admitUsageCoachRemedies, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { type UsageSessionMessageEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { ConnectedServiceQuotaGetInputV1Schema, projectProviderAccountUsageQuotaReadV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, subscribeQualifiedQuotaSnapshotEntry, type QualifiedQuotaSnapshotStoreEntry } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { isConnectedServiceUsageCapable } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot, type ServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { HappyError } from '@/utils/errors/errors';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { getUsageQueryPoolMachineSelection, isUsageProjectionHomeAccountChange, subscribeUsageQueryStateInvalidation } from './usageQueryInvalidation';
import type { ProviderAccountUsageProjectionDocuments } from './apiProviderAccountUsage';
import { encodeUsageQueryResource, type UsageByteRange } from './usageQueryResourceEncoding';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

function readOpenedQuotaScope(context: UsageQueryAccountContext) {
    const state = readRegisteredStorageState();
    const scope = context.accountLifetime.scope;
    const serverBasis = getActiveServerSnapshot();
    if (!state || !context.accountLifetime.isCurrent() || !areServerAccountScopesEqual(state.profileScope, scope)
        || state.profile.id !== scope.accountId || !areServerProfileIdentifiersEquivalent(serverBasis.serverId, scope.serverId)) return null;
    const credentialsKey = resolveAuthCredentialsScopeKey(context.credentials);
    const credentialScope = [scope.serverId, String(serverBasis.generation), credentialsKey].join('\u0000');
    return { state, providerScope: buildProviderAccountUsageScopeKey({ serverId: scope.serverId,
        generation: serverBasis.generation, credentialScope: credentialsKey }),
        sources: state.profile.connectedAccountsV4.filter(account => !shouldHideQuotaForCredentialStatus(account.status)
            && isConnectedServiceUsageCapable(account.ref.service)).map(account => ({
            source: { bindingKind: 'account' as const, ref: account.ref },
            key: buildQualifiedQuotaSnapshotScopeKey({ credentialScope, ref: account.ref,
                serverBasis: { serverId: scope.serverId, generation: serverBasis.generation } }),
        })) };
}

/** Unknown admission can retain facts; a refusal or known replacement cannot. */
function canRetainQuotaRead(admitted: Pick<QualifiedQuotaSnapshotStoreEntry, 'supported' | 'usageRecordId'>,
    read: ConnectedServiceQuotaGetResultV1): boolean {
    return admitted.supported !== false
        && (admitted.usageRecordId === null || admitted.usageRecordId === read.current?.recordId);
}

/** Observe already-admitted B; this path never probes, decrypts or refreshes a provider. */
function readOpenedQuota(context: UsageQueryAccountContext, previous?: UsageQueryBatchResult): OpenedQuotaRead {
    const scope = readOpenedQuotaScope(context);
    if (!scope) return { status: 'unknown', errorCode: 'account_profile_unavailable' };
    if (scope.sources.length === 0) return scope.state.profile.connectedAccountsV4.length === 0
        ? { status: 'unsupported', errorCode: 'no_connected_accounts' }
        : { status: 'error', errorCode: 'connected_account_needs_reauth' };
    const decision = readQuotaFeatureDecision(context, scope);
    if (decision?.state !== 'enabled') return { status: decision?.state === 'unknown' || !decision ? 'unknown' : 'unsupported' };
    const rows = getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] ?? {};
    const retainedBySource = new Map(previous?.results.flatMap(slice => slice.quota ?? [])
        .map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const previousBySource = new Map(previous?.results.flatMap(slice => slice.sources)
        .filter(state => state.source.startsWith('quota:'))
        .map(state => [state.source, state]));
    const value: ConnectedServiceQuotaGetResultV1[] = [];
    const sources: UsageQuerySourceState[] = [];
    let pending = false;
    let unavailable = false;
    let stale = false;
    const nowMs = Date.now();
    for (const { source, key } of scope.sources) {
        const admitted = getQualifiedQuotaSnapshotEntry(key);
        const row = admitted.supported === true && admitted.usageRecordId ? rows[admitted.usageRecordId] : undefined;
        const sourceKey = `quota:${createCanonicalJsonSigningInput(source)}`;
        const candidate = retainedBySource.get(createCanonicalJsonSigningInput(source));
        const retained = candidate && canRetainQuotaRead(admitted, candidate) ? candidate : undefined;
        const previousState = previousBySource.get(sourceKey);
        const settled = previousState && previousState.status !== 'pending' && previousState.status !== 'not_loaded' ? previousState : undefined;
        // The initial cache observation is a revision of the same Resource too.
        // A vendor reread cannot replace its settled history or qualified state
        // with a current-only projection before the admitted history read answers.
        // The Action may settle before this independent cache has hydrated at all.
        if (retained?.current && settled && admitted.error === null && !row?.hadError
            && (!row?.snapshot || row.snapshot.recordId === retained.current.recordId)) {
            value.push(retained);
            sources.push(settled);
            stale ||= settled.status !== 'available';
            continue;
        }
        pending ||= (admitted.loading || row?.loading === true) && (!row?.snapshot || !wasConnectedServiceQuotaObserved(row.snapshot));
        if (!row?.snapshot || row.snapshot.recordId !== admitted.usageRecordId) {
            unavailable = true;
            if (retained) {
                value.push(retained);
                // The Action may already have current facts while its history
                // is still pending and the independent cache is unhydrated.
                // Retaining those facts must retain their source state too:
                // omitting it fabricates a settled headline until the next page.
                if (previousState) sources.push(previousState);
                stale = true;
            }
            continue;
        }
        const rowStale = admitted.error !== null || row.hadError || nowMs >= row.snapshot.fetchedAtMs + row.snapshot.staleAfterMs;
        stale ||= rowStale;
        // A newly batched Usage entry may have no previous result of its own,
        // but this Account-scoped cache has already witnessed the allowance.
        if (wasConnectedServiceQuotaObserved(row.snapshot)) sources.push({ source: sourceKey,
            status: rowStale ? 'stale' : 'available', asOfMs: row.snapshot.fetchedAtMs });
        else sources.push(previousState ?? { source: sourceKey, status: 'not_loaded' });
        value.push(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: row.snapshot, nowMs,
            targets: areServerAccountScopesEqual(scope.state.settingsScope, context.accountLifetime.scope)
                ? scope.state.settings.usagePacingTargetsV1 : undefined,
            waitingWork: { status: 'unavailable', reason: 'read_failed' } }));
    }
    if (value.length) {
        const clocks = value.flatMap(row => row.current && wasConnectedServiceQuotaObserved(row.current) ? [row.current.fetchedAtMs] : []);
        return { status: unavailable || pending ? 'partial' : stale ? 'stale' : 'available', value, sources,
            ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) };
    }
    return { status: pending ? 'pending' : scope.sources.every(({ key }) => getQualifiedQuotaSnapshotEntry(key).supported === false)
        ? 'unsupported' : 'not_loaded' };
}

function readQuotaFeatureDecision(context: UsageQueryAccountContext, scope: NonNullable<ReturnType<typeof readOpenedQuotaScope>>,
    snapshot: ServerFeaturesRuntimeSnapshot = getCachedServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId })
        ?? { status: 'loading' }) {
    return resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'connectedServices.quotas',
        settings: scope.state.settings, snapshot, scope: { scopeKind: 'runtime' } });
}

export type UsageQueryAccountContext = Readonly<{
    credentials: AuthCredentials;
    accountLifetime: ServerAccountScopeLifetime;
    request: ServerFetch;
    readTransport?: CapturedServerReadTransport;
}>;

function requireCurrent(context: UsageQueryAccountContext, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!context.accountLifetime.isCurrent()) {
        throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
    }
}

/** Public tariff transport is separate from private Account settings and never carries overrides. */
const modelPriceReads = createScopedResolutionSingleFlight<UsageModelPriceCatalog>();
export async function readUiUsageModelPrices(context: UsageQueryAccountContext, refresh = false,
    signal?: AbortSignal): Promise<UsageModelPriceCatalog> {
    requireCurrent(context, signal);
    const transport = context.readTransport;
    const bindingKey = transport?.key;
    const scope = transport?.scope ?? bindingKey;
    const abort = new AbortController();
    const retirement = context.accountLifetime.onRetire(() => abort.abort());
    const cancellation = mergeAbortSignals([signal, abort.signal]);
    const consume = async (response: Response) => {
        if (!response.ok) throw new HappyError('Model price catalog unavailable', false, {
            status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
            code: response.status === 401 || response.status === 403 ? 'denied'
                : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_prices_read_failed',
        });
        return UsageModelPriceCatalogSchema.parse(await response.json());
    };
    if (refresh && scope) modelPriceReads.invalidate(scope);
    try {
        const path = refresh ? '/v1/account/usage/prices/refresh' : '/v1/account/usage/prices';
        const init = { method: refresh ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${context.credentials.token}`, ...(refresh ? { 'Content-Type': 'application/json' } : {}) },
            ...(refresh ? { body: '{}' } : {}) };
        const value = !refresh && transport && scope
            ? await modelPriceReads.run(JSON.stringify([bindingKey, path]), sharedSignal => transport.read(path, { ...init, signal: sharedSignal }, undefined, consume),
                { scope, signal: cancellation.signal })
            : await consume(await context.request(path, { ...init, signal: cancellation.signal }));
        requireCurrent(context, cancellation.signal);
        if (refresh) invalidateUsageQueryResources(context.accountLifetime);
        return value;
    } finally {
        if (refresh && scope) modelPriceReads.invalidate(scope);
        cancellation.dispose(); retirement.dispose();
    }
}

/** The quota host read and Usage batch share the same admitted Action port. */
async function withUiConnectedServiceReader<T>(context: UsageQueryAccountContext, signal: AbortSignal | undefined,
    consume: (read: (input: ConnectedServiceQuotaGetInputV1) => Promise<ConnectedServiceQuotaGetResultV1>,
        readSelection: (input: ConnectedServicePoolSelectionGetRequestV1) => Promise<ConnectedServicePoolSelectionGetResponseV1>) => Promise<T>,
    quotaReadOptions?: Pick<import('./apiProviderAccountUsage').ProviderAccountUsageQuotaReadOptions, 'readAllHistory'>) {
    const [{ captureLazyActionAccountContext }, { createUiConnectedServiceAction }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/connectedServiceActionDeps'),
    ]);
    const account = await captureLazyActionAccountContext(context.accountLifetime.scope.serverId, signal);
    try {
        requireCurrent(context, signal); account.assertCurrent();
        if (!areServerAccountScopesEqual(account.accountLifetime.scope, context.accountLifetime.scope)) {
            throw Object.assign(new Error('Quota Account authority retired'), { code: 'stale_surface' });
        }
        const action = createUiConnectedServiceAction(account, { ...quotaReadOptions,
            projectionDocuments: accountStores.get(resolveUsageOwnerLifetime(context))?.projectionDocuments });
        const invoke = async (actionId: 'connectedServices.quota.get' | 'connectedServices.pools.selection.get',
            input: ConnectedServiceQuotaGetInputV1 | ConnectedServicePoolSelectionGetRequestV1) => {
            requireCurrent(context, signal); account.assertCurrent();
            const result = await action({ actionId, input,
                context: { surface: 'ui', authority: 'present_user' }, signal });
            requireCurrent(context, signal); account.assertCurrent();
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
                throw Object.assign(new Error('error' in result ? String(result.error) : 'Quota read failed'),
                    { code: 'errorCode' in result ? result.errorCode : 'quota_read_failed' });
            }
            return result;
        };
        // The configuration executor validates its action-specific output and
        // exact source/group before returning. Recover that type at its erased
        // Action port; parsing again would clone the same admitted history.
        return await consume(async input => await invoke('connectedServices.quota.get', input) as ConnectedServiceQuotaGetResultV1,
            async input => await invoke('connectedServices.pools.selection.get', input) as ConnectedServicePoolSelectionGetResponseV1);
    } finally { account.dispose(); }
}

export async function readUiQuota(context: UsageQueryAccountContext, input: ConnectedServiceQuotaGetInputV1,
    signal?: AbortSignal): Promise<ConnectedServiceQuotaGetResultV1> {
    return await withUiConnectedServiceReader(context, signal, read => read(input));
}

function readOpenedUsagePools(context: UsageQueryAccountContext, queries: readonly UsageQuery[]): UsagePoolSourceSnapshot[] {
    const scope = readOpenedQuotaScope(context);
    return queries.map(query => {
        const selection = getUsageQueryPoolMachineSelection(scope?.state.machines ?? {}, query.machines, context.accountLifetime.scope);
        return { query, value: (scope?.state.profile.connectedAccountGroupsV4 ?? []).map(group => ({
            group: group.ref, memberAccountIds: group.members.map(member => member.connectedAccountId),
            activeAccountId: group.activeConnectedAccountId,
            selection,
        })) };
    });
}

async function readUiUsagePools(context: UsageQueryAccountContext, opened: readonly UsagePoolSourceSnapshot[], signal: AbortSignal | undefined,
    onProgress: (pools: UsagePoolSourceSnapshot[]) => void): Promise<UsagePoolSourceSnapshot[]> {
    const reads = new Map<string, Promise<UsageQueryPoolSnapshot['selection']>>();
    const values = opened.map(snapshot => ({ query: snapshot.query, value: [...snapshot.value] }));
    await Promise.all(values.flatMap(snapshot => snapshot.value.map(async (pool, index) => {
        const machineId = pool.selection.machineId;
        if (!machineId) return;
        const key = JSON.stringify([machineId, pool.group]);
        let read = reads.get(key);
        if (!read) {
            read = (async (): Promise<UsageQueryPoolSnapshot['selection']> => {
                try {
                    const value = await withUiConnectedServiceReader(context, signal, async (_quota, readSelection) =>
                        readSelection({ machineId, group: pool.group }));
                    requireCurrent(context, signal);
                    return 'status' in value ? { status: value.code === 'unsupported' ? 'unsupported' : 'error', machineId, errorCode: value.code }
                        : { status: 'available', machineId, asOfMs: value.observedAtMs, value };
                } catch (error) {
                    requireCurrent(context, signal);
                    return { status: 'error', machineId, errorCode: error && typeof error === 'object' && 'code' in error
                        && typeof error.code === 'string' ? error.code : 'connected_service_request_failed' };
                }
            })();
            reads.set(key, read);
        }
        snapshot.value[index] = { ...pool, selection: await read };
        requireCurrent(context, signal);
        onProgress(values);
    })));
    return values;
}

type OpenedQuotaRead = NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']> & Readonly<{
    sources?: readonly UsageQuerySourceState[];
}>;

async function readOpenedQuotaHistory(context: UsageQueryAccountContext, periods: readonly NonNullable<UsageAccountingSourceSnapshot['period']>[], nowMs: number, signal?: AbortSignal,
    onProgress?: (quota: OpenedQuotaRead) => void, previous?: UsageQueryBatchResult): Promise<OpenedQuotaRead> {
    const opened = readOpenedQuota(context, previous);
    const scope = readOpenedQuotaScope(context);
    if (!scope?.sources.length || readQuotaFeatureDecision(context, scope)?.state !== 'enabled') return opened;
    // Start at the existing transport batch size; the admitted B reader grows
    // subsequent pages and publishes their accepted change points progressively.
    const range = { startAtMs: Math.min(...periods.map(period => period.startMs ?? 0)),
        endAtMs: Math.max(...periods.map(period => period.endMs ?? nowMs)) };
    if (range.endAtMs <= range.startAtMs) return { status: 'unknown', errorCode: 'quota_query_range_empty' };
    const retainedBySource = new Map(opened.value?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const admissionBySource = new Map(scope.sources.map(({ source, key }) => [createCanonicalJsonSigningInput(source), key]));
    for (const value of previous?.results.flatMap(result => result.quota ?? []) ?? []) {
        const key = createCanonicalJsonSigningInput(value.source);
        const admissionKey = admissionBySource.get(key);
        if (!admissionKey || !canRetainQuotaRead(getQualifiedQuotaSnapshotEntry(admissionKey), value)) continue;
        const observed = retainedBySource.get(key);
        if (!observed?.current || observed.current.recordId === value.current?.recordId) retainedBySource.set(key, value);
    }
    const progressValues = scope.sources.map(({ source }) => retainedBySource.get(createCanonicalJsonSigningInput(source)) ?? null);
    // Account reads settle independently. Keep their qualified identity even
    // when a failed read has no current facts to disclose.
    const settledBySource = new Map(opened.sources
        ?.filter(state => state.status !== 'pending' && state.status !== 'not_loaded')
        .map(state => [state.source, state]));
    const sources: UsageQuerySourceState[] = scope.sources.map(({ source }, index) => {
        const key = `quota:${createCanonicalJsonSigningInput(source)}`;
        return progressValues[index] && settledBySource.get(key) || { source: key, status: 'pending' };
    });
    const failures = new Map<number, string>();
    const projectQuota = (status: 'available' | 'partial' | 'stale' | 'error'): OpenedQuotaRead => {
        const value = progressValues.filter((row): row is ConnectedServiceQuotaGetResultV1 => row !== null);
        const clocks = value.flatMap(row => row.current && wasConnectedServiceQuotaObserved(row.current) ? [row.current.fetchedAtMs] : []);
        // A failure answering first cannot turn the still-unanswered accounts
        // into an empty/insufficient allowance result.
        const aggregateStatus = value.length ? sources.every(source => source.status === 'available') ? 'available' : status === 'available' ? 'partial' : status
            : sources.some(source => source.status === 'pending') ? 'pending'
            : failures.size ? 'error' : status;
        return { status: aggregateStatus, sources: [...sources], ...(value.length ? { value } : {}), ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}),
            ...(failures.size && !value.length ? { errorCode: [...failures.values()][0] } : {}) };
    };
    const publishProgress = (index: number, value: ConnectedServiceQuotaGetResultV1 | null, settled = false): void => {
        requireCurrent(context, signal);
        // Warm reads retain their last settled facets until this source answers. Cold
        // reads still publish each admitted page; denials/errors take the path below.
        if (!settled && !failures.has(index) && retainedBySource.has(createCanonicalJsonSigningInput(scope.sources[index]!.source))
            && settledBySource.has(sources[index]!.source)) {
            onProgress?.(projectQuota('partial'));
            return;
        }
        const retained = retainedBySource.get(createCanonicalJsonSigningInput(scope.sources[index]!.source));
        const unobservedReplacement = value?.current && !wasConnectedServiceQuotaObserved(value.current)
            && retained?.current && wasConnectedServiceQuotaObserved(retained.current)
            && retained.current.recordId === value.current.recordId
            && canRetainQuotaRead(getQualifiedQuotaSnapshotEntry(scope.sources[index]!.key), retained);
        if (unobservedReplacement) value = retained;
        let retainedPace = false;
        if (value?.current && retained?.current && sameStrictJsonValue(value.current, retained.current)
            && canRetainQuotaRead(getQualifiedQuotaSnapshotEntry(scope.sources[index]!.key), retained)) {
            const previousPaces = new Map(retained.pace.map(row => [row.meterId, row.value]));
            const pace = value.pace.map(row => {
                const prior = previousPaces.get(row.meterId);
                // The same observation aging is not a replacement projection.
                // Keep its witnessed pace, marked stale, within that reset window.
                if (row.value.status !== 'unavailable' || row.value.reason !== 'stale' || prior?.status !== 'available'
                    || prior.window.resetAtMs <= Date.now()) return row;
                retainedPace = true;
                return { ...row, value: prior };
            });
            if (retainedPace) value = { ...value, pace };
        }
        progressValues[index] = value;
        const failure = failures.get(index);
        sources[index] = { source: sources[index]!.source,
            // Admitted current/history facts remain usable during the read.
            // Incompleteness alone cannot say whether its producer is still running.
            // Allowance/history has answered at its last page, independently of
            // the Pending-work and price facets that may still be reading.
            status: failure ? value ? 'stale' : 'error' : unobservedReplacement || retainedPace ? 'stale' : settled || value?.pageFacts?.historyStatus === 'complete' || value?.pageProjection || value?.history?.nextCursor === null
                ? value?.current && wasConnectedServiceQuotaObserved(value.current) ? 'available' : 'partial'
                : value?.current && wasConnectedServiceQuotaObserved(value.current) ? 'stale' : 'pending',
            ...(value?.current && wasConnectedServiceQuotaObserved(value.current) ? { asOfMs: value.current.fetchedAtMs } : {}),
            ...(failure ? { errorCode: failure } : {}),
        };
        onProgress?.(projectQuota('partial'));
    };
    // A cold admitted read is pending, not an unissued cache observation. Every
    // skipped read above has already returned a terminal reason.
    if (!opened.value?.length) onProgress?.({ status: 'pending', sources: [...sources] });
    const sourceIndices = new Map(scope.sources.map(({ source }, index) => [createCanonicalJsonSigningInput(source), index]));
    const acceptedBySource = new Map<number, ConnectedServiceQuotaGetResultV1>();
    const failSource = (index: number, error: unknown) => {
        requireCurrent(context, signal);
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'quota_read_failed';
        failures.set(index, code);
        if (!canRetainUsageReadFailure(code)) { publishProgress(index, null); return; }
        const accepted = acceptedBySource.get(index);
        const retained = retainedBySource.get(createCanonicalJsonSigningInput(scope.sources[index]!.source));
        // A failed replacement has not supplied a newer complete history. Keep
        // the same settled allowance and pace, with the source marked stale.
        if ((retained?.history || retained?.pageProjection || retained?.pageFacts) && settledBySource.has(sources[index]!.source)
            && (!accepted?.current || accepted.current.recordId === retained.current?.recordId)) {
            publishProgress(index, retained);
            return;
        }
        const projected = accepted?.pageFacts ? accepted : accepted ? projectProviderAccountUsageQuotaReadV1({ input: { source: scope.sources[index]!.source },
            current: accepted.current, history: accepted.history, pageProjection: accepted.pageProjection, pageFacts: accepted.pageFacts, targets: accepted.targets,
            waitingWork: accepted.waitingWork, nowMs: Date.now() })
            : retainedBySource.get(createCanonicalJsonSigningInput(scope.sources[index]!.source));
        const value = projected ? accepted?.history || accepted?.pageProjection || accepted?.pageFacts ? projected
            : { ...projected, unusedCapacity: { historyStatus: 'unavailable' as const, windows: [] } } : null;
        publishProgress(index, value);
    };
    // The batch has one captured Home/Account lifetime. Share its existing
    // mode promise and live catalog reads instead of recapturing per source.
    try {
        await withUiConnectedServiceReader(context, signal, async read => Promise.all(scope.sources.map(async ({ source }, index) => {
            try {
                const accepted = await read({ source, projection: { range, resolution: 'accepted_observations' } });
                acceptedBySource.set(index, accepted);
                publishProgress(index, accepted, true);
            } catch (error) { failSource(index, error); }
        })), { readAllHistory: { onProgress: value => {
            const index = sourceIndices.get(createCanonicalJsonSigningInput(value.source));
            if (index === undefined) throw new Error('Quota reader returned an unrequested source');
            acceptedBySource.set(index, value);
            publishProgress(index, value);
        } } });
    } catch (error) {
        // A failure capturing the common Account applies to every source;
        // an individual provider refusal above still settles independently.
        scope.sources.forEach((_source, index) => failSource(index, error));
    }
    requireCurrent(context, signal);
    return projectQuota(failures.size === 0 ? 'available' : progressValues.every(value => value !== null) ? 'stale'
        : progressValues.some(value => value !== null) ? 'partial' : 'error');
}

type SessionInputEvidence = Readonly<{
    session: Omit<Session, 'presence'> & { presence?: Session['presence'] };
    callerDataKeyEnvelope: string | null;
    detail: ReturnType<typeof projectSessionUsageWorkEvidence>;
    messageEvidence?: UsageSessionMessageEvidence;
    completeMessageCoverage: boolean;
}>;
type SessionInputReader = (sessionId: string, readTranscript: boolean,
    load: (assertCurrent: () => void, signal: AbortSignal, retained: SessionInputEvidence | undefined,
        onProgress: (value: SessionInputEvidence) => void) => Promise<SessionInputEvidence | null>,
    onProgress?: (value: SessionInputEvidence) => void) => Promise<SessionInputEvidence | null>;
type SessionAccountCurrentnessSource = ReturnType<typeof import('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope').createOperationAccountCurrentnessSource>;

type SessionInputLoadRequest = Readonly<{
    sessionId: string;
    assertCurrent: () => void;
    signal: AbortSignal;
    retained: SessionInputEvidence | undefined;
    publish: (value: SessionInputEvidence) => void;
    resolve: (value: SessionInputEvidence | null) => void;
    reject: (error: unknown) => void;
}>;

/** Collect only this finite phase's cache misses; the existing reader owns reuse and retirement. */
async function readSessionInputPhase(ids: readonly string[], readTranscript: boolean, readSession: SessionInputReader,
    loadBatch: (requests: readonly SessionInputLoadRequest[]) => Promise<void>,
    onValue: (id: string, value: SessionInputEvidence | null) => void,
    onProgress?: (id: string, value: SessionInputEvidence) => void) {
    const requests: SessionInputLoadRequest[] = [];
    const reads = ids.map(sessionId => readSession(sessionId, readTranscript,
        (assertCurrent, signal, retained, publish) => new Promise((resolve, reject) => {
            requests.push({ sessionId, assertCurrent, signal, retained, publish, resolve, reject });
        }), onProgress ? value => onProgress(sessionId, value) : undefined,
    ).then(value => { onValue(sessionId, value); return [sessionId, value] as const; }));
    const loading = requests.length ? loadBatch(requests).catch(error => {
        for (const request of requests) request.reject(error);
    }) : Promise.resolve();
    const [values] = await Promise.all([Promise.all(reads), loading]);
    return new Map(values);
}

function canReuseSessionMessageEvidence(retained: SessionInputEvidence | undefined, admitted: SessionInputEvidence) {
    return retained?.messageEvidence && retained.session.seq === admitted.session.seq
        && retained.session.encryptionMode === admitted.session.encryptionMode
        && retained.callerDataKeyEnvelope === admitted.callerDataKeyEnvelope;
}

function sessionEvidenceReadError(error: unknown): unknown {
    return error instanceof Error && 'httpStatus' in error && typeof error.httpStatus === 'number' && error.httpStatus >= 500
        ? new RetryableServerResponseError(error.httpStatus, 'Session input evidence unavailable') : error;
}

async function readHowYouWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[],
    accounting: readonly UsageAccountingSourceSnapshot[], readSession: SessionInputReader,
    readAccountCurrentnessSource: () => Promise<SessionAccountCurrentnessSource>,
    signal?: AbortSignal, onProgress?: (snapshots: readonly HowYouWorkEvidenceSnapshot[], sources: readonly UsageQuerySourceState[]) => void) {
    const active = captureActiveServerAccountScopeLifetime();
    const loadedState = active?.isCurrent() && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope)
        ? readRegisteredStorageState() : null;
    const state = loadedState && areServerAccountScopesEqual(loadedState.profileScope, context.accountLifetime.scope) ? loadedState : null;
    const candidates = Object.values(state?.sessions ?? {}).filter(session => !session.serverId
        || areServerProfileIdentifiersEquivalent(session.serverId, context.accountLifetime.scope.serverId));
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value?.contributions]));
    const idsByQuery = new Map(queries.map(query => [getUsageQueryKey(query), selectUsageQueryWorkEvidenceSessionIds({ query,
        sessions: candidates, contributions: byQuery.get(getUsageQueryKey(query)) })]));
    const selectedIds = [...new Set([...idsByQuery.values()].flat())];
    const readTranscript = queries.some(query => query.includeTranscriptEvidence);
    const loadTranscript = async (sessionId: string, assertCurrent: () => void, signal: AbortSignal,
        retained: SessionInputEvidence | undefined, publish: (value: SessionInputEvidence) => void,
        admitted: SessionInputEvidence,
        readMessagePage: () => Promise<Readonly<{ status: number; body: unknown }> | undefined>): Promise<SessionInputEvidence | null> => {
        try {
            const [{ runWithServerRequestAuthorityForServerAccountScope }, { fetchSessionMessagesPage }, { readStoredSessionMessage }, accountCurrentnessSource] = await Promise.all([
                import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                import('@happier-dev/sync-client'), import('@/sync/runtime/readStoredSessionContent'),
                readAccountCurrentnessSource(),
            ]);
            return await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
                assertCurrent();
                requireCurrent(context, signal);
                const { session, callerDataKeyEnvelope } = admitted;
                requireCurrent(context, signal);
                // Admitted interval facts remain available while private pages read.
                const summary = admitted;
                publish(summary);
                let messageEvidence: UsageSessionMessageEvidence | undefined;
                let detail = summary.detail;
                let completeMessageCoverage = false;
                if (session.access?.capabilities.readTranscript !== false && isSessionContentReadable(readSessionContentAvailability(session))) {
                  if (canReuseSessionMessageEvidence(retained, admitted)) {
                    messageEvidence = retained!.messageEvidence;
                    completeMessageCoverage = retained!.completeMessageCoverage;
                    detail = projectSessionUsageWorkEvidence(session, undefined, { messagesComplete: completeMessageCoverage, messageEvidence });
                  } else {
                    let page: Awaited<ReturnType<typeof fetchSessionMessagesPage>> | null = null;
                    try {
                        page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'], signal,
                            requestJson: async (_path, pageSignal) => {
                                requireCurrent(context, pageSignal);
                                const response = await readMessagePage();
                                if (!response || response.status !== 200) {
                                    if (response && response.status >= 500) throw new RetryableServerResponseError(response.status, 'Session input evidence unavailable');
                                    throw new Error('Session input evidence unavailable');
                                }
                                requireCurrent(context, pageSignal);
                                return response.body;
                            } });
                    } catch (error) {
                        requireCurrent(context, signal);
                        // Only an ordinary transport failure can retain the
                        // freshly admitted Session facts. Access/format failures
                        // quarantine them; no previously loaded content is revived.
                        if (!isTransientConnectivityError(error)) throw error;
                    }
                    if (page !== null) {
                        // Summary admission and transcript demand can use different
                        // scoped Account owners. Hydrate this operation's reader
                        // from the admitted envelope, without reacquiring the Session.
                        const encryption = session.encryptionMode === 'plain' ? null
                            : await (await import('@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey'))
                                .resolveScopedSessionEncryption({ context: authority.context, sessionId, admittedSession: {
                                    id: session.id, encryptionMode: 'e2ee', dataEncryptionKey: callerDataKeyEnvelope,
                                    viewerRole: session.access?.role ?? 'recipient',
                                    isCurrent: () => { assertCurrent(); return accountCurrentnessSource.isCurrent(); },
                                } });
                        const decryptedMessages = encryption ? await encryption.decryptMessages(page.messages, { signal }) : null;
                        const messages = await Promise.all(page.messages.map((message, index) => readStoredSessionMessage({ message,
                            sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
                            ...(encryption ? { decryptMessage: async () => decryptedMessages?.[index] ?? null } : {}),
                        })));
                        const readableMessages = messages.filter((message): message is NonNullable<typeof message> => message !== null && message.content !== null);
                        // An empty raw page was observed; a wholly unopened nonempty
                        // page supplies no private input evidence, not a zero count.
                        completeMessageCoverage = page.hasMore === false && readableMessages.length === page.messages.length;
                        if (page.messages.length === 0 || readableMessages.length > 0) {
                            detail = projectSessionUsageWorkEvidence(session, readableMessages, { messagesComplete: completeMessageCoverage });
                            messageEvidence = { acceptedInputs: detail.acceptedInputs, phaseEvents: detail.phaseEvents, coach: detail.coach,
                                collaboration: detail.collaboration };
                        }
                    }
                  }
                }
                requireCurrent(context, signal);
                assertCurrent();
                return { session, callerDataKeyEnvelope, detail, messageEvidence, completeMessageCoverage };
            });
        } catch {
            requireCurrent(context, signal);
            assertCurrent();
            return null;
        }
    };
    const selected = new Map<string, SessionInputEvidence | null>();
    const settled = new Set<string>();
    let publishedPhase: string | undefined;
    const project = (): HowYouWorkEvidenceSnapshot[] => queries.map(query => {
        // Loaded Sessions supply demand, never an access/content fallback after
        // a fresh exact-Account admission fails or denies transcript access.
        const sessions = (idsByQuery.get(getUsageQueryKey(query)) ?? []).flatMap(id => selected.get(id)?.session ? [selected.get(id)!.session] : []);
        const sessionEvidence = new Map([...selected].flatMap(([id, entry]) => entry ? [[id, entry.detail] as const] : []));
        const detail = projectUsageQueryWorkEvidence({ query, scope: context.accountLifetime.scope,
            currentScope: query.session === null ? active?.scope ?? null : context.accountLifetime.scope,
            isCurrent: context.accountLifetime.isCurrent() && (query.session !== null || active?.isCurrent() === true), sessions, sessionEvidence,
            contributions: byQuery.get(getUsageQueryKey(query)) });
        // A refused, failed or superseded Session read cannot turn the remaining
        // lanes into a complete Agent-time total. Withdraw the aggregate until
        // every selected Session is admitted; never retain withdrawn private facts.
        const completeIntervals = (idsByQuery.get(getUsageQueryKey(query)) ?? []).every(id => {
            const session = selected.get(id)?.session;
            return session && session.access?.capabilities.readTranscript !== false
                && isSessionContentReadable(readSessionContentAvailability(session));
        });
        const sessionCoverage = { selected: (idsByQuery.get(getUsageQueryKey(query)) ?? []).length,
            admitted: sessions.filter(session => session.access?.capabilities.readTranscript !== false
                && isSessionContentReadable(readSessionContentAvailability(session))).length };
        return { query, asOfMs: Date.now(), sessions, sessionCoverage,
            detail: completeIntervals ? detail : { ...detail, facts: undefined, closedTurns: undefined, activityAtMs: undefined } };
    });
    const publish = () => {
        if (signal?.aborted || !context.accountLifetime.isCurrent()) return;
        const admitted = selectedIds.every(id => selected.has(id));
        const readable = selectedIds.every(id => {
            const session = selected.get(id)?.session;
            return session && session.access?.capabilities.readTranscript !== false
                && isSessionContentReadable(readSessionContentAvailability(session));
        });
        const refused = [...selected.values()].some(value => value === null);
        const sources: UsageQuerySourceState[] = [
            { source: 'how_you_work:sessions', status: !admitted ? 'pending' : readable ? 'available' : 'partial' },
            { source: 'how_you_work:transcripts', status: !readTranscript ? 'not_loaded' : settled.size < selectedIds.length ? 'pending'
                : readable && selectedIds.every(id => selected.get(id)?.completeMessageCoverage) ? 'available' : 'partial' },
        ];
        // Publish the admitted interval phase before held transcript I/O, then
        // the completed input phase. Individual unfinished Session completions
        // do not change those phases: projecting and serializing the complete
        // Account for each one makes a cold pass quadratic. A refusal still
        // withdraws private facts immediately, independently of completion.
        const phase = JSON.stringify([sources, refused]);
        if (phase === publishedPhase) return;
        publishedPhase = phase;
        onProgress?.(admitted || refused ? project() : [], sources);
    };
    publish();
    const onValue = (sessionId: string, value: SessionInputEvidence | null, complete: boolean) => {
        requireCurrent(context, signal);
        const changed = !selected.has(sessionId) || selected.get(sessionId) !== value;
        selected.set(sessionId, value);
        if (complete) settled.add(sessionId);
        // Cached progress already supplied these exact facts. Only the last
        // completion changes the aggregate's pending state; reprojecting every
        // identical completion turns one refresh into N full-corpus passes.
        if (changed || settled.size === selectedIds.length) publish();
    };
    const summaries = await readSessionInputPhase(selectedIds, false, readSession, async requests => {
        const ownerSignal = requests[0]!.signal;
        try {
            const [{ runWithServerRequestAuthorityForServerAccountScope }, { readSessionSnapshotsForAuthority }, accountCurrentnessSource] = await Promise.all([
                import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'), readAccountCurrentnessSource(),
            ]);
            await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
                const snapshots = await readSessionSnapshotsForAuthority({ authority, sessionIds: requests.map(request => request.sessionId),
                    requireTurns: true, accountCurrentnessSource, isCurrent: context.accountLifetime.isCurrent, signal: ownerSignal });
                for (const request of requests) {
                    try {
                        request.assertCurrent();
                        const result = snapshots.get(request.sessionId);
                        if (result && !result.ok && request.retained && isTransientConnectivityError(sessionEvidenceReadError(result.error))) {
                            request.reject(sessionEvidenceReadError(result.error));
                            continue;
                        }
                        request.resolve(result?.ok ? { ...result.snapshot, detail: projectSessionUsageWorkEvidence(result.snapshot.session),
                            completeMessageCoverage: false } : null);
                    } catch { request.resolve(null); }
                }
            });
        } catch (error) {
            requireCurrent(context, ownerSignal);
            const failure = sessionEvidenceReadError(error);
            for (const request of requests) {
                // Failed replacement is not a new empty admission. Let the
                // Resource retain its admitted snapshot and expose the failure;
                // cold reads and actual refusals still withdraw unavailable facts.
                if (request.retained && isTransientConnectivityError(failure)) request.reject(failure);
                else request.resolve(null);
            }
        }
    }, (id, value) => onValue(id, value, !readTranscript || !value));
    // Transcript demand adds one messages-only transport batch to the same
    // admitted summaries. Held pages never hold interval publication.
    if (readTranscript) await readSessionInputPhase(selectedIds.filter(id => summaries.get(id)), true, readSession, async requests => {
        const ownerSignal = requests[0]!.signal;
        const [{ runWithServerRequestAuthorityForServerAccountScope }, { readSessionBatchForAuthority }, accountCurrentnessSource] = await Promise.all([
            import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
            import('@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority'), readAccountCurrentnessSource(),
        ]);
        await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
            const messageIds = requests.filter(request => {
                const admitted = summaries.get(request.sessionId)!;
                return admitted.session.access?.capabilities.readTranscript !== false
                    && isSessionContentReadable(readSessionContentAvailability(admitted.session))
                    && !canReuseSessionMessageEvidence(request.retained, admitted);
            }).map(request => request.sessionId);
            const pages = readSessionBatchForAuthority({ authority, sessionIds: messageIds, includeSnapshot: false, includeMessages: true,
                signal: ownerSignal, assertCurrent: () => { requireCurrent(context, ownerSignal); accountCurrentnessSource.assertCurrent(); } })
                .then(rows => ({ ok: true as const, rows }), error => ({ ok: false as const, error }));
            await Promise.all(requests.map(async request => {
                const value = await loadTranscript(request.sessionId, request.assertCurrent, request.signal, request.retained, request.publish,
                    summaries.get(request.sessionId)!, async () => {
                        const result = await pages;
                        if (result.ok) return result.rows.get(request.sessionId)?.messages;
                        requireCurrent(context, ownerSignal);
                        throw sessionEvidenceReadError(result.error);
                    });
                request.resolve(value);
            }));
            await pages;
        });
    }, (id, value) => onValue(id, value, true), (id, value) => { selected.set(id, value); publish(); });
    requireCurrent(context, signal);
    return project();
}

type HowYouWorkEvidenceSnapshot = Readonly<{
    query: UsageQuery; asOfMs: number;
    sessions: readonly SessionInputEvidence['session'][];
    sessionCoverage: NonNullable<UsageHowYouWorkSourceSnapshot['sessionCoverage']>;
    detail: ReturnType<typeof projectUsageQueryWorkEvidence>;
    errorCode?: string;
}>;
type HowYouWorkReadSnapshot = HowYouWorkEvidenceSnapshot
    | Readonly<{ query: UsageQuery; errorCode: string; detail?: undefined; sessions?: undefined }>;

type SessionWorkSourceResult = import('@happier-dev/protocol/usage/usageWorkSources').SessionWorkSourceResult;

async function readSessionWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[],
    accounting: readonly UsageAccountingSourceSnapshot[], sessionReads: Map<string, Promise<SessionWorkSourceResult>>,
    signal?: AbortSignal): Promise<readonly UsageWorkSourceSnapshot[]> {
    return collectUsageWorkSources({ queries, accounting, sessionReads, assertCurrent: () => requireCurrent(context, signal),
        readSession: async sessionId => {
            const scope = context.accountLifetime.scope;
            if (!readMachineControlTargetForSession({ sessionId, serverId: scope.serverId, accountId: scope.accountId })) return null;
            return (method, request) => runSessionScmRpc(sessionId, method, request, scope.serverId, signal, scope.accountId);
        },
    });
}

/** Capture the Home carrier and real Account lifetime; neither is a query input. */
export function captureUiUsageQueryAccountContext(credentials: AuthCredentials): UsageQueryAccountContext | null {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent() || parseToken(credentials.token) !== accountLifetime.scope.accountId) return null;
    const profile = getServerProfileById(accountLifetime.scope.serverId);
    if (!profile) return null;
    const accountEncryptionObservation = captureAccountEncryptionObservationForHome({
        serverId: accountLifetime.scope.serverId, endpointUrl: profile.canonicalServerUrl ?? profile.serverUrl,
        credentials, isCurrent: accountLifetime.isCurrent,
    });
    const request: ServerFetch = async (path, init, options) => {
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
        const transport = await resolveServerScopedTransport({ profile, credentials });
        try {
            const response = await createServerFetchAtEndpoint({
                endpointUrl: transport.canonicalServerUrl, runtimeOrigin: transport.runtimeOrigin,
                serverId: accountLifetime.scope.serverId, credentials,
                isCurrent: accountLifetime.isCurrent,
                accountEncryptionObservation,
                ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            })(path, init, options);
            if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
            return response;
        } finally { await transport.release(); }
    };
    bindAccountEncryptionObservation(request, accountEncryptionObservation);
    return { credentials, accountLifetime, request,
        readTransport: createCapturedServerReadTransport({ serverId: accountLifetime.scope.serverId, profile, credentials, accountEncryptionObservation }) };
}

/** One Action port batches resolved A requests; B/backfill never delays available A. */
export async function readUiUsageQueryBatch(
    context: UsageQueryAccountContext,
    input: UsageQueryBatchInput,
    signal?: AbortSignal,
    previous?: UsageQueryBatchResult,
    options?: Readonly<{ onProgress?: (value: UsageQueryBatchResult) => void }>,
): Promise<UsageQueryBatchResult> {
    requireCurrent(context, signal);
    const { queries } = normalizeUsageQueryBatchInput(input);
    const accountingNowMs = Date.now();
    const reads = resolveUsagePageAccountingReads(queries, accountingNowMs);
    const requests = reads.map(read => read.query);
    const periods = new Map([...queries.map(query => [getUsageQueryKey(query), resolveUsageQueryPeriod(query, accountingNowMs)] as const),
        ...reads.map(read => [getUsageQueryKey(read.query), read.period] as const)]);
    const priorAccounting = new Map(previous?.results.flatMap(slice => [
        [slice.key, { value: slice.accounting, asOfMs: slice.sources.find(source => source.source === 'accounting')?.asOfMs }] as const,
        ...(slice.comparison ? [[getUsageQueryKey(slice.comparison.query), { value: slice.comparison.accounting,
            asOfMs: slice.comparison.source.asOfMs }] as const] : []),
    ]));
    const accounting = new Map<string, UsageAccountingSourceSnapshot>(requests.map(query => {
        const retained = priorAccounting.get(getUsageQueryKey(query));
        return [getUsageQueryKey(query), { query, period: periods.get(getUsageQueryKey(query)), status: 'pending' as const,
            ...(retained?.value ? { value: retained.value } : {}),
            ...(retained?.asOfMs === undefined ? {} : { asOfMs: retained.asOfMs }) } satisfies UsageAccountingSourceSnapshot] as const;
    }));
    const evidenceQueries = queries.filter(query => query.includeAccounting && query.includeSessionEvidence);
    let work: readonly UsageWorkSourceSnapshot[] = queries.map(query => ({ query, status: query.includeAccounting && query.includeWorkEvidence ? 'pending' : 'not_loaded' }));
    const sessionWorkReads = new Map<string, Promise<SessionWorkSourceResult>>();
    getUsageQueryResourceStore(context);
    const accountOwner = accountStores.get(resolveUsageOwnerLifetime(context))!;
    const sessionInputReader = accountOwner.readSessionInput;
    // One finite Account batch shares the scoped reader's existing observation.
    // It stays lazy: unchanged retained Session inputs need no currentness GET.
    let sessionCurrentness: Promise<SessionAccountCurrentnessSource> | undefined;
    let sessionCurrentnessClosed = false;
    const readSessionCurrentness = () => {
        if (sessionCurrentnessClosed) throw Object.assign(new Error('Usage Session evidence read completed'), {
            code: 'account_encryption_currentness_changed',
        });
        return sessionCurrentness ??= import('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope')
            .then(({ createOperationAccountCurrentnessSource }) => {
                const source = createOperationAccountCurrentnessSource({
                    credentials: context.credentials, request: context.request,
                    serverId: context.accountLifetime.scope.serverId,
                });
                if (sessionCurrentnessClosed) source.dispose();
                return source;
            });
    };
    let howYouWork: readonly HowYouWorkReadSnapshot[] | undefined;
    const howYouWorkByQuery = new Map<string, HowYouWorkReadSnapshot>();
    const howYouWorkSourcesByQuery = new Map<string, readonly UsageQuerySourceState[]>();
    const settledHowYouWorkQueries = new Set<string>();
    let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    let mcpCatalogRead: Promise<McpServerCatalogSnapshotV1> | undefined;
    let quota: OpenedQuotaRead = readOpenedQuota(context, previous);
    let pools = readOpenedUsagePools(context, queries);
    const priorSlices = new Map(previous?.results.map(slice => [slice.key, slice]));
    let admittedPrevious = previous;
    // All effects share this read's lifetime; snapshots are published directly
    // into its entry, never cached or rerun just to advance independent sources.
    const compose = (): UsageQueryBatchResult => {
        requireCurrent(context, signal);
        if (queries.every(query => !query.includeAccounting)) {
            return resolveUsageQuotaPageAggregation({ queries, previous: admittedPrevious, quota, pools,
                sources: quota.sources, nowMs: accountingNowMs });
        }
        const settingsState = readRegisteredStorageState();
        const accountSettings = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults });
        // Price belongs to the admitted A response, not each quota/selection publication.
        // Keep its derived value in this read's existing per-query snapshot map.
        for (const [key, snapshot] of accounting) accounting.set(key,
            projectUsageAccountingSnapshotPrices(snapshot, accountSettings.usageModelPriceOverridesV1, accounting.values()));
        const sourceLocations = Object.values(readOpenedQuotaScope(context)?.state.machines ?? {}).flatMap(machine => {
            const displayLocation = readMachineName(machine);
            return displayLocation ? [{ machineId: machine.id, displayLocation }] : [];
        });
        // A rolling reread requests a new absolute window. Until current
        // accounting answers, the displayed window still owns its exact old
        // comparison; it is being replaced, not definitively absent.
        const witnessedComparison = previous?.results.flatMap(slice => {
            const comparison = slice.comparison;
            if (!comparison?.accounting || accounting.has(getUsageQueryKey(comparison.query))) return [];
            return [{ query: comparison.query, value: comparison.accounting,
                status: accounting.get(slice.key)?.status === 'pending' ? 'pending' as const : 'stale' as const,
                ...(comparison.source.asOfMs === undefined ? {} : { asOfMs: comparison.source.asOfMs }) }];
        }) ?? [];
        const batch = resolveUsagePageAggregation({ queries, accounting: [...accounting.values(), ...witnessedComparison], previous: admittedPrevious,
            sourceLocations,
            pricingOverrides: accountSettings.usageModelPriceOverridesV1, coachPreferences: accountSettings.usageCoachPreferencesV1,
            nightHours: accountSettings.usageNightHoursV1,
            quota, pools, work, howYouWork, nowMs: accountingNowMs,
            sources: [...(quota.sources ?? []), ...(settledHowYouWorkQueries.size < evidenceQueries.length
                ? [{ source: 'how_you_work', status: 'pending' as const }]
                : evidenceQueries.length === 0 ? [{ source: 'how_you_work', status: 'not_loaded' as const }] : [])] });
        // The base source remains pending until the complete private read
        // settles. Its staged facts and reading phases belong to this query,
        // never a held sibling in the same batch.
        const staged = { ...batch, results: batch.results.map(slice => {
            const sources = howYouWorkSourcesByQuery.get(slice.key);
            if (!sources) return slice;
            const pending = !settledHowYouWorkQueries.has(slice.key);
            const observed = [...slice.sources].reverse().find(source => source.source === 'how_you_work');
            return { ...slice, pending: slice.pending || pending,
                sources: [...slice.sources.filter(source => source.source !== 'how_you_work'),
                    { ...observed, source: 'how_you_work', status: pending ? 'pending' as const : observed?.status ?? 'unknown' },
                    ...sources] };
        }) };
        const preferred = applyCoachPreferences(staged, howYouWork ?? []);
        return { ...preferred, results: preferred.results.map(slice => {
            const priorSources = priorSlices.get(slice.key)?.sources;
            if (!priorSources) return slice;
            return { ...slice, sources: slice.sources.map(source => {
                if (source.status !== 'pending') return source;
                const prior = priorSources.find(candidate => candidate.source === source.source);
                // Keep the admitted observation's date and any settled failure
                // while its replacement is in flight. Slice/Resource pending
                // still reports the actual work; it does not erase that result.
                if (prior?.status === 'error') return prior;
                return source.asOfMs === undefined && prior?.asOfMs !== undefined
                    ? { ...source, asOfMs: prior.asOfMs } : source;
            }) };
        }) };
    };
    const publish = (): void => {
        if (!options?.onProgress) return;
        // Read identity and pending sources are useful before the first facts.
        // The mounted body model keeps a source-only revision as a placeholder.
        const batch = compose();
        admittedPrevious = batch;
        options.onProgress(batch);
    };
    // Available preference-backed facts can progress while another source's
    // read remains pending. The Account settings owner remains the authority.
    const readNightHours = () => {
        const state = readRegisteredStorageState();
        return readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: state?.settingsScope, focusedSettings: state?.settings ?? settingsDefaults }).usageNightHoursV1;
    };
    let observedNightHours = readNightHours();
    const unwatchNightHours = options?.onProgress ? subscribeRegisteredStorageState(() => {
        if (!context.accountLifetime.isCurrent() || signal?.aborted) return;
        const next = readNightHours();
        if (sameStrictJsonValue(observedNightHours, next)) return;
        observedNightHours = next;
        publish();
    }) : undefined;
    try {
        publish();
        const accountingTasks = new Map(requests.map(query => [getUsageQueryKey(query), (async () => {
        let snapshot: UsageAccountingSourceSnapshot;
        try {
            const request = usageQueryToAnalyticsRequest({ ...query, period: periods.get(getUsageQueryKey(query))! }, accountingNowMs);
            const value = await accountOwner.readAccounting(request, signal);
            const asOfMs = resolveUsageAccountingAsOfMs(value);
            snapshot = { query, period: periods.get(getUsageQueryKey(query)), value, status: 'available', ...(asOfMs === undefined ? {} : { asOfMs }) };
        } catch (error) {
            requireCurrent(context, signal);
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'usage_query_failed';
            if (!canRetainUsageReadFailure(errorCode)) throw error;
            const retained = priorAccounting.get(getUsageQueryKey(query));
            // Detail/Work membership must see the same retained accounting as
            // aggregation, rather than shrinking to the currently hydrated Sessions.
            snapshot = retainAccountingOnReadFailure({ query, period: periods.get(getUsageQueryKey(query)), status: 'error', errorCode },
                retained?.value, retained?.asOfMs)!;
        }
        requireCurrent(context, signal);
        accounting.set(getUsageQueryKey(query), snapshot);
        publish();
        })()]));
        await Promise.all([
        ...accountingTasks.values(),
        ...queries.map(async (query, index) => {
            if (!query.includeAccounting || !query.includeWorkEvidence) return;
            // Each slice needs only its own contributions. Native Session reads
            // are still shared across slices within this one Action admission.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            const sources = await readSessionWorkEvidence(context, [query], [...accounting.values()], sessionWorkReads, signal);
            work = work.map((source, sourceIndex) => sourceIndex === index
                ? { ...sources[0]!, ...(sources[0]!.status === 'error' ? {} : { asOfMs: accountingNowMs }) } : source);
            publish();
        }),
        ...evidenceQueries.map(async query => {
            // Current accounting owns historical dimension membership. A held
            // comparison or sibling query must not delay this slice's detail.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            let snapshots: Awaited<ReturnType<typeof readHowYouWorkEvidence>>;
            try {
                snapshots = await readHowYouWorkEvidence(context, [query], [...accounting.values()], sessionInputReader, readSessionCurrentness, signal,
                    (snapshots, sources) => {
                        requireCurrent(context, signal);
                        const key = getUsageQueryKey(query);
                        if (!snapshots[0] && sameStrictJsonValue(howYouWorkSourcesByQuery.get(key), sources)) return;
                        howYouWorkSourcesByQuery.set(key, sources);
                        if (snapshots[0]) {
                            howYouWorkByQuery.set(key, snapshots[0]);
                            howYouWork = [...howYouWorkByQuery.values()];
                        }
                        publish();
                    });
            } catch (error) {
                requireCurrent(context, signal);
                if (!isTransientConnectivityError(error)) throw error;
                const key = getUsageQueryKey(query);
                const errorCode = 'usage_session_evidence_read_failed';
                // Keep any actual partial admission/refusal already published.
                // Otherwise the shared aggregation owner retains the prior facts.
                howYouWorkByQuery.set(key, { ...(howYouWorkByQuery.get(key) ?? { query }), errorCode });
                howYouWork = [...howYouWorkByQuery.values()];
                howYouWorkSourcesByQuery.set(key, (howYouWorkSourcesByQuery.get(key) ?? []).map(source =>
                    source.status === 'pending' ? { ...source, status: 'error', errorCode } : source));
                settledHowYouWorkQueries.add(key);
                publish();
                return;
            }
            // Binding advice and its catalog admission are one private-evidence
            // result. Unrelated quota/history reads must not hold them back.
            if (snapshots[0]!.detail.coach?.detail?.mcpUsage?.length) {
                mcpCatalogRead ??= import('./apiMcpServerCatalog').then(({ readMcpServerCatalog }) =>
                    readMcpServerCatalog(context.accountLifetime.scope, signal, () => requireCurrent(context, signal)));
                mcpCatalog = await mcpCatalogRead;
                requireCurrent(context, signal);
            }
            howYouWorkByQuery.set(getUsageQueryKey(query), snapshots[0]!);
            howYouWork = [...howYouWorkByQuery.values()];
            settledHowYouWorkQueries.add(getUsageQueryKey(query));
            publish();
        }),
        (async () => { quota = await readOpenedQuotaHistory(context, queries.map(query => periods.get(getUsageQueryKey(query))!), accountingNowMs, signal, value => { quota = value; publish(); }, previous); publish(); })(),
        (async () => { pools = await readUiUsagePools(context, pools, signal, value => { pools = value; publish(); }); publish(); })(),
        ]);
        return compose();
    } finally {
        sessionCurrentnessClosed = true;
        unwatchNightHours?.();
        // Construction is only a module import and local observation capture;
        // never await a pending private network read during teardown.
        await sessionCurrentness?.then(source => source.dispose(), () => undefined);
    }

    function applyCoachPreferences(batch: UsageQueryBatchResult, howYouWork: readonly HowYouWorkReadSnapshot[]): UsageQueryBatchResult {
        const openedByQuery = new Map(howYouWork.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
        const settingsState = readRegisteredStorageState();
        const preferences = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults }).usageCoachPreferencesV1;
        const nowMs = Date.now();
        const results = batch.results.map(slice => {
            const opened = openedByQuery.get(slice.key);
            if (!slice.coach) return slice;
            const proposals = !opened?.detail || opened.detail.status === 'unknown' ? [] : buildUsageCoachRemedies({ findings: slice.coach.findings.filter(finding => finding.remedy === null),
                composition: opened.detail.coach?.composition ?? [], sessions: opened.sessions,
                mcpUsage: opened.detail.coach?.detail?.mcpUsage ?? [], ...(mcpCatalog ? { mcpCatalog } : {}),
                serverId: context.accountLifetime.scope.serverId, accountId: context.accountLifetime.scope.accountId });
            const coach = proposals.length === 0 ? slice.coach : admitUsageCoachRemedies(slice.coach,
                [...(opened?.detail?.coach?.admittedRemedies ?? []), ...proposals]);
            const preferred = applyUsageCoachPreferences(coach, preferences, nowMs);
            return preferred === slice.coach ? slice : { ...slice, coach: preferred };
        });
        return results.every((slice, index) => slice === batch.results[index]) ? batch : { ...batch, results };
    }
}

type UsageQueryInvalidation = HomeAccountChangeEvent | 'session-evidence';
type AccountResourceOwner = Readonly<{ store: PluginUiResourceStore; invalidate(event?: UsageQueryInvalidation): void; readSessionInput: SessionInputReader;
    readAccounting(request: Parameters<typeof queryUsageAnalytics>[1], signal?: AbortSignal): Promise<Awaited<ReturnType<typeof queryUsageAnalytics>>>;
    projectionDocuments: ProviderAccountUsageProjectionDocuments }>;
// This is the existing Resource store's Account ownership, not a response cache.
const accountStores = new WeakMap<ServerAccountScopeLifetime, AccountResourceOwner>();
const INVALIDATION_DIGEST = computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('usage-owner-invalidation'));

function resolveUsageOwnerLifetime(context: UsageQueryAccountContext): ServerAccountScopeLifetime {
    const active = captureActiveServerAccountScopeLifetime();
    return active && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope) ? active : context.accountLifetime;
}

export function invalidateUsageQueryResources(lifetime = captureActiveServerAccountScopeLifetime()): void {
    if (!lifetime?.isCurrent()) return;
    // Actions wrap the captured lifetime; mounted Resources use the active
    // same-Account lifetime. Match the existing store admission normalization.
    const active = captureActiveServerAccountScopeLifetime();
    const ownerLifetime = active && areServerAccountScopesEqual(active.scope, lifetime.scope) ? active : lifetime;
    accountStores.get(ownerLifetime)?.invalidate();
}

/** Mounted host widgets and admitted plugin host reads acquire this exact store. */
export function getUsageQueryResourceStore(context: UsageQueryAccountContext): PluginUiResourceStore {
    requireCurrent(context);
    const active = captureActiveServerAccountScopeLifetime();
    const sharedContext = active && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope)
        ? { ...context, ...captureUiUsageQueryAccountContext(context.credentials) } : context;
    const lifetime = sharedContext.accountLifetime;
    const existing = accountStores.get(lifetime);
    if (existing) return existing.store;
    const evidenceAbort = new AbortController();
    const accountingReads = createScopedResolutionSingleFlight<Awaited<ReturnType<typeof queryUsageAnalytics>>>();
    const projectionDocuments: ProviderAccountUsageProjectionDocuments = new Map();
    // Allowances belong to this Account, not a page's accounting batch. Keep
    // their latest Resource revision across navigation, including zero views.
    // New query ranges still read their own history; these facts seed the body
    // until that replacement answers, rather than claiming its range is read.
    let allowance: Pick<UsageQueryBatchResult['results'][number], 'key' | 'requestedQuery' | 'shownQuery' | 'quota' | 'sources' | 'pending'> | undefined;
    // Queries move between route batches as visible widgets register. These
    // are the same Account Resource's admitted slices, independent of batch membership.
    // Keep private evidence and selector state beside accounting so a changed
    // widget demand cannot retire only part of the same query's admission.
    const slicesByQuery = new Map<string, UsageQueryBatchResult['results'][number]>();
    const sessionInputs = new Map<string, { sessionId: string; basis: string; needsAdmission: boolean;
        value?: SessionInputEvidence; read: Promise<SessionInputEvidence | null>;
        listeners: Set<(value: SessionInputEvidence) => void> }>();
    const readSessionState = (id: string) => {
        const state = readRegisteredStorageState();
        const session = state && areServerAccountScopesEqual(state.profileScope, lifetime.scope) ? state.sessions[id] : undefined;
        return session && (!session.serverId || areServerProfileIdentifiersEquivalent(session.serverId, lifetime.scope.serverId)) ? session : undefined;
    };
    const readSessionRow = (id: string) => {
        const state = readRegisteredStorageState();
        return state && areServerAccountScopesEqual(state.profileScope, lifetime.scope)
            ? readSessionListRowForServerId(state.sessionListRowsByServerId, lifetime.scope.serverId, id) : null;
    };
    const version = (session: Pick<Session, 'seq' | 'updatedAt' | 'metadataVersion' | 'agentStateVersion'
        | 'metadataLayoutVersion' | 'encryptionMode' | 'encryptedContentAvailability' | 'access'> | null | undefined) => [
        session?.seq, session?.updatedAt, session?.metadataVersion, session?.agentStateVersion,
        session?.metadataLayoutVersion, session?.encryptionMode, session?.encryptedContentAvailability, session?.access,
    ];
    const readEvidenceBasis = (id: string) => {
        const session = readSessionState(id);
        // Compact list rows survive detail eviction. Observe both owners' input
        // versions, while exact content admission still uses the snapshot reader.
        return JSON.stringify([getAccountEncryptionModeCacheRevision(), version(session), session?.sessionTurns?.updatedAt, version(readSessionRow(id))]);
    };
    const listeners = new Map<(event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation) => void, Readonly<{
        queries: readonly UsageQuery[];
        previous(): UsageQueryBatchResult | undefined;
        machineId?: string;
    }>>();
    const owner: AccountResourceOwner = {
        projectionDocuments,
        async readAccounting(request, signal) {
            requireCurrent(sharedContext, signal);
            const cancellation = mergeAbortSignals([signal, evidenceAbort.signal]);
            try {
                const load = (readSignal: AbortSignal) => queryUsageAnalytics(sharedContext.credentials, request,
                    { request: sharedContext.request, readTransport: sharedContext.readTransport, signal: readSignal });
                // Opaque invocation-bound request closures cannot prove neutral cancellation.
                // Only the captured physical transport enables cross-batch borrowing.
                const transport = sharedContext.readTransport;
                const bindingKey = transport?.key;
                const value = transport
                    ? await accountingReads.run(JSON.stringify([bindingKey,
                        createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(request))]), load,
                        { scope: transport.scope ?? bindingKey, signal: cancellation.signal })
                    : await load(cancellation.signal);
                requireCurrent(sharedContext, cancellation.signal);
                return value;
            } finally { cancellation.dispose(); }
        },
        readSessionInput(sessionId, readTranscript, load, onProgress) {
            requireCurrent(sharedContext);
            const basis = readEvidenceBasis(sessionId);
            // Summary admission cannot satisfy later private transcript demand,
            // and a held transcript must not hold an interval-only consumer.
            const key = JSON.stringify([sessionId, readTranscript]);
            const retained = sessionInputs.get(key);
            const observe = (entry: NonNullable<ReturnType<typeof sessionInputs.get>>) => {
                if (!onProgress) return entry.read;
                entry.listeners.add(onProgress);
                if (entry.value) onProgress(entry.value);
                return entry.read.finally(() => entry.listeners.delete(onProgress));
            };
            if (retained && retained.basis === basis && !retained.needsAdmission) return observe(retained);
            const assertCurrent = () => {
                requireCurrent(sharedContext, evidenceAbort.signal);
                if (sessionInputs.get(key) !== entry || readEvidenceBasis(sessionId) !== basis || entry.needsAdmission) {
                    throw Object.assign(new Error('Usage Session evidence changed'), { code: 'usage_session_evidence_changed' });
                }
            };
            const entry: NonNullable<ReturnType<typeof sessionInputs.get>> = { sessionId, basis, needsAdmission: false,
                read: Promise.resolve<SessionInputEvidence | null>(null), listeners: new Set() };
            sessionInputs.set(key, entry);
            entry.read = load(assertCurrent, evidenceAbort.signal, retained?.value, value => {
                assertCurrent();
                entry.value = value;
                for (const listener of entry.listeners) listener(value);
            }).then(value => {
                assertCurrent();
                if (value) entry.value = value;
                // A selected historical Session need not be loaded in the list.
                // Its admitted version is reusable too; failures stay retryable.
                // A successful partial page is still the result of this exact
                // scope/roles read at this Session version. Repeating it cannot
                // complete history. Failed or wholly unopened pages stay retryable.
                if ((!value || readTranscript && !value.messageEvidence && !value.completeMessageCoverage)
                    && sessionInputs.get(key) === entry) sessionInputs.delete(key);
                return value;
            }).catch(error => {
                if (sessionInputs.get(key) === entry) {
                    if (retained?.value && isTransientConnectivityError(error)
                        && sharedContext.accountLifetime.isCurrent() && readEvidenceBasis(sessionId) === basis) {
                        // Keep admission custody across repeated failed replacements,
                        // but require the next reader to try admission again.
                        entry.value = retained.value;
                        entry.needsAdmission = true;
                    } else sessionInputs.delete(key);
                }
                if (error && typeof error === 'object' && 'code' in error && error.code === 'usage_session_evidence_changed') return null;
                throw error;
            });
            return observe(entry);
        },
        store: createPluginUiResourceStore({ accountLifetime: lifetime, client: {
            resourceKey(reference) {
                if (typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query') {
                    return JSON.stringify(['host', 'usage.query', getUsageQueryBatchKey(reference.input)]);
                }
                return pluginUiResourceReferenceKey(reference, null);
            },
            async readResource(reference, options) {
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                requireCurrent(sharedContext, options?.signal);
                syncQualifiedSubscriptions();
                if (reference.hostRead === 'connectedServices.quota.get') {
                    const result = await readUiQuota(sharedContext, ConnectedServiceQuotaGetInputV1Schema.parse(reference.input), options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    const digest = await computePluginUiArtifactSha256Digest(bytes);
                    requireCurrent(sharedContext, options?.signal);
                    return { contentType: 'application/json', bytes, digest };
                }
                if (reference.hostRead === 'connectedServices.pools.selection.get') {
                    const input = ConnectedServicePoolSelectionGetRequestV1Schema.parse(reference.input);
                    const result = await withUiConnectedServiceReader(sharedContext, options?.signal, (_readQuota, readSelection) => readSelection(input));
                    requireCurrent(sharedContext, options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    const digest = computePluginUiArtifactSha256DigestV1(bytes);
                    return { contentType: 'application/json', bytes, digest };
                }
                if (reference.hostRead !== 'usage.query') throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                const entry = owner.store.getEntry(reference);
                // Keep the admitted facts, not the superseded serialized bytes,
                // in this async frame while unrelated source reads are pending.
                const ownPrevious = (() => {
                    const retained = entry.getSnapshot().value;
                    return retained ? decodeUsageQueryResource(retained) : undefined;
                })();
                const queries = normalizeUsageQueryBatchInput(reference.input).queries;
                const previousByKey = new Map(ownPrevious?.results.map(slice => [slice.key, slice]));
                const previousSlices = queries.flatMap(query => {
                    const key = getUsageQueryKey(query);
                    const slice = previousByKey.get(key) ?? slicesByQuery.get(key);
                    return slice ? [slice] : [];
                });
                const priorBatch = previousSlices.length ? { v: 1 as const, results: previousSlices } : undefined;
                const sharedAllowance = allowance;
                const previous = priorBatch && sharedAllowance ? { ...priorBatch, results: priorBatch.results.map(slice => ({
                    ...slice, quota: sharedAllowance.quota,
                    sources: [...slice.sources.filter(source => source.source !== 'quota' && !source.source.startsWith('quota:')),
                        ...sharedAllowance.sources],
                })) } : priorBatch ?? (sharedAllowance ? { v: 1 as const, results: [sharedAllowance] } : undefined);
                const contentFor = async (batch: UsageQueryBatchResult): Promise<ResourceContent> => {
                    requireCurrent(sharedContext, options?.signal);
                    // An older in-flight batch may publish after a sibling has
                    // settled. Pending is activity, never a replacement for those facts.
                    if (allowance) {
                        const opened = readOpenedQuotaScope(sharedContext);
                        const admitted = new Map(opened?.sources.map(({ source, key }) =>
                            [createCanonicalJsonSigningInput(source), getQualifiedQuotaSnapshotEntry(key)]));
                        const states = new Map(allowance.sources.map(state => [state.source, state]));
                        const reads = new Map(allowance.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                        batch = { ...batch, results: batch.results.map(slice => {
                            const replacements = new Map<string, ConnectedServiceQuotaGetResultV1>();
                            const sources = slice.sources.map(state => {
                                if (!state.source.startsWith('quota:') || !['pending', 'not_loaded'].includes(state.status)) return state;
                                const key = state.source.slice('quota:'.length);
                                const settled = states.get(state.source);
                                const read = reads.get(key);
                                const admission = admitted.get(key);
                                if (!settled || ['pending', 'not_loaded'].includes(settled.status) || !read || !admission
                                    || !canRetainQuotaRead(admission, read)) return state;
                                replacements.set(key, read);
                                return settled;
                            });
                            if (!replacements.size) return slice;
                            const quota = new Map(slice.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                            replacements.forEach((read, key) => quota.set(key, read));
                            const qualified = sources.filter(state => state.source.startsWith('quota:'));
                            const status = qualified.every(state => state.status === 'available') ? 'available' as const
                                : qualified.some(state => state.status === 'stale') ? 'stale' as const : 'partial' as const;
                            const clocks = qualified.flatMap(state => state.asOfMs === undefined ? [] : [state.asOfMs]);
                            const settledSources = sources.map(state => state.source === 'quota'
                                ? { ...state, status, ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) } : state);
                            return { ...slice, quota: [...quota.values()], sources: settledSources };
                        }) };
                    }
                    const first = batch.results[0];
                    if (first) allowance = { key: first.key, requestedQuery: first.requestedQuery, shownQuery: first.shownQuery,
                        quota: first.quota, sources: first.sources.filter(source => source.source === 'quota' || source.source.startsWith('quota:')),
                        pending: first.sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:')) && source.status === 'pending') };
                    for (const slice of batch.results) slicesByQuery.set(slice.key, slice);
                    const current = entry.getSnapshot().value;
                    // Reconcile each revision against the same entry's admitted
                    // value so unrelated slices keep their selected references.
                    const currentBatch = current ? decodeUsageQueryResource(current) : undefined;
                    const value = retainUsageQueryResultReferences(batch, currentBatch, ownPrevious);
                    // Reuse the entry's bytes as well as its decoded value. A
                    // terminal read commonly repeats its last progress revision.
                    if (current && value === currentBatch) return current;
                    const encoded = encodeUsageQueryResource(value, current ? {
                        bytes: current.bytes, ranges: decodedValues.get(current)?.ranges,
                    } : undefined);
                    const bytes = encoded.bytes;
                    const digest = await computePluginUiArtifactSha256Digest(bytes);
                    requireCurrent(sharedContext, options?.signal);
                    const content = { contentType: 'application/json', bytes, digest } as const;
                    decodedValues.set(content, { value, ranges: encoded.ranges });
                    return content;
                };
                let queuedProgress: UsageQueryBatchResult | null = null;
                let progressContent: Promise<void> | null = null;
                const drainProgress = (): void => {
                    if (progressContent) return;
                    progressContent = (async () => {
                        while (queuedProgress) {
                            const batch = queuedProgress;
                            queuedProgress = null;
                            const content = await contentFor(batch);
                            options?.onProgress?.(content);
                        }
                    })().finally(() => { progressContent = null; });
                    // The final read awaits the same drain. Observe a prompt
                    // rejection now so a slow producer cannot turn an eventual
                    // read failure into an unhandled one.
                    void progressContent.catch(() => {});
                };
                let result: UsageQueryBatchResult;
                try {
                    // This is the typed producer used by progressive admission,
                    // not an external Action response. Dispatching it through
                    // the Action again clones all admitted facts at completion.
                    result = await readUiUsageQueryBatch(sharedContext, { queries }, options?.signal, previous,
                        { onProgress: batch => {
                            queuedProgress = batch;
                            drainProgress();
                        } });
                } catch (error) {
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    if (typeof code === 'string' && !canRetainUsageReadFailure(code)) {
                        allowance = undefined;
                        owner.projectionDocuments.clear();
                        slicesByQuery.clear();
                    }
                    throw error;
                }
                requireCurrent(sharedContext, options?.signal);
                // The final value supersedes any progress revision that has not
                // started materializing yet. Finish only the in-flight digest.
                queuedProgress = null;
                await progressContent;
                return await contentFor(result);
            },
            async watchResource(reference, listener, options) {
                requireCurrent(sharedContext, options?.signal);
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                const allowanceOnly = reference.hostRead === 'usage.query'
                    && normalizeUsageQueryBatchInput(reference.input).queries.every(query => !query.includeAccounting);
                const observe = (event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation) => {
                    // Session/accounting evidence does not change Capacity.
                    // Material Profile/Settings/Machine inputs still invalidate
                    // through their existing state subscription below.
                    if (allowanceOnly && (change === 'session-evidence'
                        || change && !isUsageProjectionHomeAccountChange(change))) return;
                    listener(event);
                };
                listeners.set(observe, {
                    queries: reference.hostRead === 'usage.query' ? normalizeUsageQueryBatchInput(reference.input).queries : [],
                    previous: () => {
                        if (reference.hostRead !== 'usage.query') return undefined;
                        const content = owner.store.getEntry(reference).getSnapshot().value;
                        return content ? decodeUsageQueryResource(content) : undefined;
                    },
                    ...(reference.hostRead === 'connectedServices.pools.selection.get'
                        ? { machineId: ConnectedServicePoolSelectionGetRequestV1Schema.parse(reference.input).machineId } : {}),
                });
                const dispose = () => { listeners.delete(observe); options?.signal?.removeEventListener('abort', dispose); };
                options?.signal?.addEventListener('abort', dispose, { once: true });
                return { dispose };
            },
        } }),
        invalidate(homeChange) {
            if (!lifetime.isCurrent()) return;
            // A replacement demanded by this wake must not join pre-wake accounting.
            // Existing borrowers retain their own publication and Account fences.
            accountingReads.invalidate(sharedContext.readTransport?.scope ?? sharedContext.readTransport?.key);
            for (const listener of [...listeners.keys()]) listener({ version: 1, subscriptionId: 'usage-query', kind: 'invalidated', digest: INVALIDATION_DIGEST }, homeChange);
        },
    };
    accountStores.set(lifetime, owner);
    const qualifiedUnwatches = new Map<string, () => void>();
    function syncQualifiedSubscriptions(): void {
        const keys = new Set(readOpenedQuotaScope(sharedContext)?.sources.map(({ key }) => key));
        for (const [key, dispose] of qualifiedUnwatches) {
            if (!keys.has(key)) { dispose(); qualifiedUnwatches.delete(key); }
        }
        for (const key of keys) if (!qualifiedUnwatches.has(key)) {
            let observed = getQualifiedQuotaSnapshotEntry(key);
            qualifiedUnwatches.set(key, subscribeQualifiedQuotaSnapshotEntry(key, () => {
                const next = getQualifiedQuotaSnapshotEntry(key);
                const admissionChanged = next.supported !== observed.supported || next.usageRecordId !== observed.usageRecordId;
                const settled = !next.loading && !next.refreshing;
                const changed = admissionChanged || settled && (next.error === null) !== (observed.error === null);
                // Beginning acquisition clears the cache's error optimistically;
                // only its settled answer can replace that error observation.
                if (admissionChanged || settled) observed = next;
                // This reader consumes admission, not the cache's acquisition
                // flags. Starting/finishing an unchanged read is not invalidation.
                if (changed) owner.invalidate();
            }));
        }
    }
    syncQualifiedSubscriptions();
    const unwatch = subscribeHomeAccountChange(event => {
        if (event.usageQueryAffects !== false && areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) {
            // Exact Session changes fence their own admission. A content-free
            // Account wake is not evidence that every loaded Session changed:
            // those versions are observed below at the existing state owner.
            // Reconnects and Sessions absent from that owner still need fresh
            // admission when the wake cannot name the changed Session.
            if (event.source === 'connected' || event.changeKinds === undefined || event.changeKinds.includes('session')) {
                if (event.entityIds === undefined || event.source === 'connected') {
                    sessionInputs.forEach(entry => {
                        if (event.source === 'connected' || !readSessionState(entry.sessionId) && !readSessionRow(entry.sessionId)) entry.needsAdmission = true;
                    });
                } else sessionInputs.forEach(entry => {
                    if (event.entityIds?.includes(entry.sessionId)) entry.needsAdmission = true;
                });
            }
            syncQualifiedSubscriptions();
            owner.invalidate(event);
        }
    });
    const readProviderRows = () => {
        const scope = readOpenedQuotaScope(sharedContext);
        return scope ? getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] : undefined;
    };
    let observedRows = readProviderRows();
    const unwatchProvider = subscribeProviderAccountUsageCache(() => {
        const rows = readProviderRows();
        if (rows === observedRows) return;
        const previous = observedRows;
        observedRows = rows;
        // Cache loading, retry deadlines and observation-only publications do
        // not change Usage facts. Preserve real replacement/removal and errors.
        const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(rows ?? {})]);
        if ([...keys].some(key => previous?.[key]?.hadError !== rows?.[key]?.hadError
            || !sameStrictJsonValue(previous?.[key]?.snapshot, rows?.[key]?.snapshot))) owner.invalidate();
    });
    let observedFeatures = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
    const unwatchFeatures = subscribeServerFeaturesSnapshot(() => {
        const features = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
        if (features === observedFeatures) return;
        const scope = readOpenedQuotaScope(sharedContext);
        // Usage consumes the quota decision, not unrelated discovery fields or
        // a replacement snapshot's identity. Compare both with current settings.
        const changed = scope && scope.sources.length > 0
            && readQuotaFeatureDecision(sharedContext, scope, observedFeatures ?? { status: 'loading' })?.state
                !== readQuotaFeatureDecision(sharedContext, scope, features ?? { status: 'loading' })?.state;
        observedFeatures = features;
        if (changed) owner.invalidate();
    });
    const unwatchState = subscribeUsageQueryStateInvalidation(() => {
        syncQualifiedSubscriptions();
        owner.invalidate();
    }, machines => {
        const opened = readOpenedQuotaScope(sharedContext);
        const poolMachineFilters: (readonly string[])[] = [];
        const sessionMachineIds = new Set<string>();
        if (!opened) return { poolMachineFilters, sessionMachineIds: [] };
        // Read mounted demand and its already-admitted value from the Resource
        // owner. No acquisition or second response lifetime lives in this key.
        const state = { ...opened.state, machines };
        const sessionIds = new Set<string>();
        for (const watched of listeners.values()) {
            if (opened.state.profile.connectedAccountGroupsV4.length) {
                poolMachineFilters.push(...watched.queries.map(query => query.machines));
            }
            if (watched.machineId) sessionMachineIds.add(watched.machineId);
            for (const slice of watched.previous()?.results ?? []) {
                if (!slice.requestedQuery.includeAccounting || !slice.requestedQuery.includeWorkEvidence) continue;
                for (const row of slice.accounting?.contributions ?? []) {
                    if (!row.sessionId || !row.turnId) continue;
                    sessionIds.add(row.sessionId);
                }
            }
        }
        for (const sessionId of sessionIds) {
            const target = resolveMachineControlTargetForSessionFromState(state, { ...lifetime.scope, sessionId });
            const displayId = resolveDisplayMachineIdForSessionFromState({ state, serverId: lifetime.scope.serverId, sessionId });
            if (target) sessionMachineIds.add(target.machineId);
            if (displayId) sessionMachineIds.add(displayId);
        }
        return { poolMachineFilters, sessionMachineIds: [...sessionMachineIds] };
    });
    let observedSessions = readRegisteredStorageState()?.sessions;
    let observedSessionRows = readRegisteredStorageState()?.sessionListRowsByServerId;
    let observedProfileScope = readRegisteredStorageState()?.profileScope;
    const unwatchSessions = subscribeRegisteredStorageState(state => {
        if (state.sessions === observedSessions && state.sessionListRowsByServerId === observedSessionRows
            && state.profileScope === observedProfileScope) return;
        const previousSessions = observedSessions;
        const scopeChanged = !areServerAccountScopesEqual(state.profileScope, observedProfileScope);
        observedSessions = state.sessions;
        observedSessionRows = state.sessionListRowsByServerId;
        observedProfileScope = state.profileScope;
        // Candidate membership is also an input: a list arriving after a cold
        // empty read must wake demand even when it has no cached evidence yet.
        const ids = Object.keys(state.sessions);
        let changed = scopeChanged || ids.length !== Object.keys(previousSessions ?? {}).length
            || ids.some(id => !previousSessions?.[id]);
        for (const entry of sessionInputs.values()) {
            if (readEvidenceBasis(entry.sessionId) === entry.basis) continue;
            entry.needsAdmission = true;
            changed = true;
        }
        if (changed) owner.invalidate(scopeChanged ? undefined : 'session-evidence');
    });
    const unwatchCredentials = subscribeHomeCredentialMutations(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
        if (event.kind === 'credentials_set' && event.credentials
            && resolveAuthCredentialsScopeKey(event.credentials) === resolveAuthCredentialsScopeKey(sharedContext.credentials)) return;
        owner.store.dispose();
        evidenceAbort.abort();
        sessionInputs.clear();
        owner.projectionDocuments.clear();
        slicesByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        unwatchSessions?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    lifetime.onRetire(() => {
        owner.store.dispose();
        evidenceAbort.abort();
        sessionInputs.clear();
        owner.projectionDocuments.clear();
        slicesByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        listeners.clear();
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        unwatchSessions?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    return owner.store;
}

// Decode once per admitted immutable Resource value so independent consumers
// select the same slice reference. No response or request lifetime lives here.
const decodedValues = new WeakMap<ResourceContent, Readonly<{
    value: UsageQueryBatchResult;
    /** Locations in these exact bytes, not a second retained byte representation. */
    ranges?: ReadonlyMap<object, UsageByteRange>;
}>>();

export function decodeUsageQueryResource(value: ResourceContent): UsageQueryBatchResult {
    const existing = decodedValues.get(value);
    if (existing) return existing.value;
    const decoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes)));
    decodedValues.set(value, { value: decoded });
    return decoded;
}
