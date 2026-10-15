import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { executeUsageAction } from '@happier-dev/protocol/actions/executor/usageActions';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQueryBatchInput, usageQueryToAnalyticsRequest, type UsageQuery, type UsageQueryBatchInput } from '@happier-dev/protocol/inputs/usageQuery';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { resolveUsagePageAggregation, resolveUsagePageAccountingReads, resolveUsageAccountingAsOfMs, retainUsageQueryResultReferences, UsageQueryBatchResultSchema, type UsageAccountingSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQueryBatchResult, type UsageWorkSourceSnapshot, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServicePoolSelectionGetRequestV1Schema, ConnectedServicePoolSelectionGetResponseV1Schema, type ConnectedServicePoolSelectionGetRequestV1, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { computePluginUiArtifactSha256Digest } from '@/sync/domains/plugins/ui/artifactIntegrity';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { queryUsageAnalytics } from './apiUsage';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds } from '@/sync/domains/usage/usageWorkEvidence';
import { buildUsageCoachRemedies } from '@/sync/domains/usage/buildUsageCoachRemedies';
import { admitUsageCoachRemedies, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { DecryptedMessage, Session } from '@/sync/domains/state/storageTypes';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { ConnectedServiceQuotaGetInputV1Schema, ConnectedServiceQuotaGetResultV1Schema, projectProviderAccountUsageQuotaReadV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, subscribeQualifiedQuotaSnapshotEntry, type QualifiedQuotaSnapshotStoreEntry } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { HappyError } from '@/utils/errors/errors';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { subscribeUsageQueryStateInvalidation } from './usageQueryInvalidation';

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
        sources: state.profile.connectedAccountsV4.filter(account => !shouldHideQuotaForCredentialStatus(account.status)).map(account => ({
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

function readQuotaFeatureDecision(context: UsageQueryAccountContext, scope: NonNullable<ReturnType<typeof readOpenedQuotaScope>>) {
    return resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'connectedServices.quotas',
        settings: scope.state.settings, snapshot: getCachedServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId })
            ?? { status: 'loading' }, scope: { scopeKind: 'runtime' } });
}

export type UsageQueryAccountContext = Readonly<{
    credentials: AuthCredentials;
    accountLifetime: ServerAccountScopeLifetime;
    request: ServerFetch;
}>;

function requireCurrent(context: UsageQueryAccountContext, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!context.accountLifetime.isCurrent()) {
        throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
    }
}

/** Public tariff transport is separate from private Account settings and never carries overrides. */
export async function readUiUsageModelPrices(context: UsageQueryAccountContext, refresh = false,
    signal?: AbortSignal): Promise<UsageModelPriceCatalog> {
    requireCurrent(context, signal);
    const response = await context.request(refresh ? '/v1/account/usage/prices/refresh' : '/v1/account/usage/prices', {
        method: refresh ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${context.credentials.token}`, ...(refresh ? { 'Content-Type': 'application/json' } : {}) },
        ...(refresh ? { body: '{}' } : {}), ...(signal ? { signal } : {}),
    });
    requireCurrent(context, signal);
    if (!response.ok) throw new HappyError('Model price catalog unavailable', false, {
        status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
        code: response.status === 401 || response.status === 403 ? 'denied'
            : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_prices_read_failed',
    });
    const raw: unknown = await response.json();
    requireCurrent(context, signal);
    const value = UsageModelPriceCatalogSchema.parse(raw);
    if (refresh) invalidateUsageQueryResources(context.accountLifetime);
    return value;
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
        const action = createUiConnectedServiceAction(account, quotaReadOptions);
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
        return await consume(async input => ConnectedServiceQuotaGetResultV1Schema.parse(await invoke('connectedServices.quota.get', input)),
            async input => ConnectedServicePoolSelectionGetResponseV1Schema.parse(await invoke('connectedServices.pools.selection.get', input)));
    } finally { account.dispose(); }
}

export async function readUiQuota(context: UsageQueryAccountContext, input: ConnectedServiceQuotaGetInputV1,
    signal?: AbortSignal): Promise<ConnectedServiceQuotaGetResultV1> {
    return await withUiConnectedServiceReader(context, signal, read => read(input));
}

function readOpenedUsagePools(context: UsageQueryAccountContext, queries: readonly UsageQuery[]): UsagePoolSourceSnapshot[] {
    const scope = readOpenedQuotaScope(context);
    return queries.map(query => {
        const machines = Object.values(scope?.state.machines ?? {}).filter(machine => !isMachineReplaced(machine)
            && isMachineReachable(context.accountLifetime.scope, machine)
            && (query.machines.length === 0 || query.machines.includes(machine.id)));
        const machineId = machines.length === 1 ? machines[0]!.id : undefined;
        return { query, value: (scope?.state.profile.connectedAccountGroupsV4 ?? []).map(group => ({
            group: group.ref, memberAccountIds: group.members.map(member => member.connectedAccountId),
            activeAccountId: group.activeConnectedAccountId,
            selection: machineId ? { status: 'pending' as const, machineId }
                : machines.length > 1 ? { status: 'unknown' as const }
                    : { status: 'unsupported' as const, errorCode: 'no_machine' },
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
            status: failure ? value ? 'stale' : 'error' : unobservedReplacement || retainedPace ? 'stale' : settled || value?.pageProjection || value?.history?.nextCursor === null
                ? value?.current && wasConnectedServiceQuotaObserved(value.current) ? 'available' : 'partial' : 'pending',
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
        if (['denied', 'permission_denied', 'stale_surface'].includes(code)) { publishProgress(index, null); return; }
        const accepted = acceptedBySource.get(index);
        const retained = retainedBySource.get(createCanonicalJsonSigningInput(scope.sources[index]!.source));
        // A failed replacement has not supplied a newer complete history. Keep
        // the same settled allowance and pace, with the source marked stale.
        if ((retained?.history || retained?.pageProjection) && settledBySource.has(sources[index]!.source)
            && (!accepted?.current || accepted.current.recordId === retained.current?.recordId)) {
            publishProgress(index, retained);
            return;
        }
        const projected = accepted ? projectProviderAccountUsageQuotaReadV1({ input: { source: scope.sources[index]!.source },
            current: accepted.current, history: accepted.history, pageProjection: accepted.pageProjection, targets: accepted.targets,
            waitingWork: accepted.waitingWork, nowMs: Date.now() })
            : retainedBySource.get(createCanonicalJsonSigningInput(scope.sources[index]!.source));
        const value = projected ? accepted?.history || accepted?.pageProjection ? projected
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
    openedMessages?: readonly DecryptedMessage[];
    completeMessageCoverage: boolean;
}>;
type SessionInputReader = (sessionId: string,
    load: (assertCurrent: () => void, signal: AbortSignal, retained?: SessionInputEvidence) => Promise<SessionInputEvidence | null>) => Promise<SessionInputEvidence | null>;

async function readHowYouWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[],
    accounting: readonly UsageAccountingSourceSnapshot[], readSession: SessionInputReader,
    signal?: AbortSignal) {
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
    const loadSession = async (sessionId: string, assertCurrent: () => void, signal: AbortSignal,
        retained?: SessionInputEvidence): Promise<SessionInputEvidence | null> => {
        try {
            const [{ runWithServerRequestAuthorityForServerAccountScope }, { readSessionSnapshotForAuthority }, { fetchSessionMessagesPage }, { readStoredSessionMessage }] = await Promise.all([
                import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
                import('@happier-dev/sync-client'), import('@/sync/runtime/readStoredSessionContent'),
            ]);
            return await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
                assertCurrent();
                requireCurrent(context, signal);
                const { session } = await readSessionSnapshotForAuthority({ authority, sessionId, isCurrent: context.accountLifetime.isCurrent });
                requireCurrent(context, signal);
                let openedMessages: readonly DecryptedMessage[] | undefined;
                let completeMessageCoverage = false;
                if (session.access?.capabilities.readTranscript !== false && isSessionContentReadable(readSessionContentAvailability(session))) {
                  if (retained?.completeMessageCoverage && retained.session.seq === session.seq
                    && retained.session.encryptionMode === session.encryptionMode) {
                    openedMessages = retained.openedMessages;
                    completeMessageCoverage = true;
                  } else {
                    let page: Awaited<ReturnType<typeof fetchSessionMessagesPage>> | null = null;
                    try {
                        page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'], signal,
                            requestJson: async (path, pageSignal) => {
                                requireCurrent(context, pageSignal);
                                const response = await authority.request(path, { signal: pageSignal });
                                if (!response.ok) {
                                    if (response.status >= 500) throw new RetryableServerResponseError(response.status, 'Session input evidence unavailable');
                                    throw new Error('Session input evidence unavailable');
                                }
                                const value: unknown = await response.json();
                                requireCurrent(context, pageSignal);
                                return value;
                            } });
                    } catch (error) {
                        requireCurrent(context, signal);
                        // Only an ordinary transport failure can retain the
                        // freshly admitted Session facts. Access/format failures
                        // quarantine them; no previously loaded content is revived.
                        if (!isTransientConnectivityError(error)) throw error;
                    }
                    if (page !== null) {
                        const encryption = authority.context.encryption?.getSessionEncryption(sessionId);
                        const messages = await Promise.all(page.messages.map(message => readStoredSessionMessage({ message,
                            sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
                            ...(encryption ? { decryptMessage: async (row) => (await encryption.decryptMessages([row]))[0] ?? null } : {}),
                        })));
                        const readableMessages = messages.filter((message): message is DecryptedMessage => message !== null && message.content !== null);
                        // An empty raw page was observed; a wholly unopened nonempty
                        // page supplies no private input evidence, not a zero count.
                        if (page.messages.length === 0 || readableMessages.length > 0) openedMessages = readableMessages;
                        completeMessageCoverage = page.hasMore === false && readableMessages.length === page.messages.length;
                    }
                  }
                }
                requireCurrent(context, signal);
                assertCurrent();
                return { session, openedMessages, completeMessageCoverage };
            });
        } catch {
            requireCurrent(context, signal);
            assertCurrent();
            return null;
        }
    };
    const selected = new Map(await Promise.all(selectedIds.map(async sessionId => {
        return [sessionId, await readSession(sessionId, (assertCurrent, ownerSignal, retained) => loadSession(sessionId, assertCurrent, ownerSignal, retained))] as const;
    })));
    requireCurrent(context, signal);
    const asOfMs = Date.now();
    return queries.map(query => {
        // Loaded Sessions supply demand, never an access/content fallback after
        // a fresh exact-Account admission fails or denies transcript access.
        const sessions = (idsByQuery.get(getUsageQueryKey(query)) ?? []).flatMap(id => selected.get(id)?.session ? [selected.get(id)!.session] : []);
        const openedMessages = new Map([...selected].flatMap(([id, entry]) => entry?.openedMessages !== undefined
            ? [[id, entry.openedMessages] as const] : []));
        const completeMessageSessionIds = new Set([...selected].flatMap(([id, entry]) => entry?.completeMessageCoverage ? [id] : []));
        const detail = projectUsageQueryWorkEvidence({ query, scope: context.accountLifetime.scope,
            currentScope: query.session === null ? active?.scope ?? null : context.accountLifetime.scope,
            isCurrent: context.accountLifetime.isCurrent() && (query.session !== null || active?.isCurrent() === true), sessions, openedMessages,
            completeMessageSessionIds, contributions: byQuery.get(getUsageQueryKey(query)) });
        // A refused, failed or superseded Session read cannot turn the remaining
        // lanes into a complete Agent-time total. Withdraw the aggregate until
        // every selected Session is admitted; never retain withdrawn private facts.
        const completeIntervals = (idsByQuery.get(getUsageQueryKey(query)) ?? []).every(id => {
            const session = selected.get(id)?.session;
            return session && session.access?.capabilities.readTranscript !== false
                && isSessionContentReadable(readSessionContentAvailability(session));
        });
        return { query, asOfMs, sessions, detail: completeIntervals ? detail : { ...detail, facts: undefined, activityAtMs: undefined } };
    });
}

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
    const request: ServerFetch = async (path, init, options) => {
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
        const transport = await resolveServerScopedTransport({ profile, credentials });
        try {
            const response = await createServerFetchAtEndpoint({
                endpointUrl: transport.canonicalServerUrl, runtimeOrigin: transport.runtimeOrigin,
                serverId: accountLifetime.scope.serverId, credentials,
                isCurrent: accountLifetime.isCurrent,
                ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            })(path, init, options);
            if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
            return response;
        } finally { await transport.release(); }
    };
    return { credentials, accountLifetime, request };
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
    const periods = new Map(reads.map(read => [getUsageQueryKey(read.query), read.period]));
    const accountingReads = new Map<string, Promise<Awaited<ReturnType<typeof queryUsageAnalytics>>>>();
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
    const evidenceQueries = queries.filter(query => query.includeSessionEvidence);
    let work: readonly UsageWorkSourceSnapshot[] = queries.map(query => ({ query, status: query.includeWorkEvidence ? 'pending' : 'not_loaded' }));
    const sessionWorkReads = new Map<string, Promise<SessionWorkSourceResult>>();
    getUsageQueryResourceStore(context);
    const sessionInputReader = accountStores.get(resolveUsageOwnerLifetime(context))!.readSessionInput;
    let howYouWork: Awaited<ReturnType<typeof readHowYouWorkEvidence>> | undefined;
    const howYouWorkByQuery = new Map<string, Awaited<ReturnType<typeof readHowYouWorkEvidence>>[number]>();
    let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    let quota: OpenedQuotaRead = readOpenedQuota(context, previous);
    let pools = readOpenedUsagePools(context, queries);
    let admittedPrevious = previous;
    // All effects share this read's lifetime; snapshots are published directly
    // into its entry, never cached or rerun just to advance independent sources.
    const compose = (): UsageQueryBatchResult => {
        requireCurrent(context, signal);
        const settingsState = readRegisteredStorageState();
        const accountSettings = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults });
        const sourceLocations = Object.values(readOpenedQuotaScope(context)?.state.machines ?? {}).flatMap(machine => {
            const displayLocation = readMachineName(machine);
            return displayLocation ? [{ machineId: machine.id, displayLocation }] : [];
        });
        const batch = resolveUsagePageAggregation({ queries, accounting: [...accounting.values()], previous: admittedPrevious,
            sourceLocations,
            pricingOverrides: accountSettings.usageModelPriceOverridesV1, coachPreferences: accountSettings.usageCoachPreferencesV1,
            nightHours: accountSettings.usageNightHoursV1,
            quota, pools, work, howYouWork, nowMs: accountingNowMs,
            sources: [...(quota.sources ?? []), ...(howYouWorkByQuery.size < evidenceQueries.length
                ? [{ source: 'how_you_work', status: 'pending' as const }]
                : evidenceQueries.length === 0 ? [{ source: 'how_you_work', status: 'not_loaded' as const }] : [])] });
        return applyCoachPreferences(batch, howYouWork ?? []);
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
            const requestKey = createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(request));
            let read = accountingReads.get(requestKey);
            if (!read) {
                read = queryUsageAnalytics(context.credentials, request, { request: context.request, signal });
                accountingReads.set(requestKey, read);
            }
            const value = await read;
            const asOfMs = resolveUsageAccountingAsOfMs(value);
            snapshot = { query, period: periods.get(getUsageQueryKey(query)), value, status: 'available', ...(asOfMs === undefined ? {} : { asOfMs }) };
        } catch (error) {
            requireCurrent(context, signal);
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'usage_query_failed';
            if (['denied', 'permission_denied', 'stale_surface'].includes(errorCode)) throw error;
            snapshot = { query, period: periods.get(getUsageQueryKey(query)), status: 'error', errorCode };
        }
        requireCurrent(context, signal);
        accounting.set(getUsageQueryKey(query), snapshot);
        publish();
        })()]));
        await Promise.all([
        ...accountingTasks.values(),
        ...queries.map(async (query, index) => {
            if (!query.includeWorkEvidence) return;
            // Each slice needs only its own contributions. Native Session reads
            // are still shared across slices within this one Action admission.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            const sources = await readSessionWorkEvidence(context, [query], [...accounting.values()], sessionWorkReads, signal);
            work = work.map((source, sourceIndex) => sourceIndex === index ? sources[0]! : source);
            publish();
        }),
        ...evidenceQueries.map(async query => {
            // Current accounting owns historical dimension membership. A held
            // comparison or sibling query must not delay this slice's detail.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            const snapshots = await readHowYouWorkEvidence(context, [query], [...accounting.values()], sessionInputReader, signal);
            howYouWorkByQuery.set(getUsageQueryKey(query), snapshots[0]!);
            howYouWork = [...howYouWorkByQuery.values()];
            publish();
        }),
        (async () => { quota = await readOpenedQuotaHistory(context, queries.map(query => periods.get(getUsageQueryKey(query))!), accountingNowMs, signal, value => { quota = value; publish(); }, previous); publish(); })(),
        (async () => { pools = await readUiUsagePools(context, pools, signal, value => { pools = value; publish(); }); publish(); })(),
        ]);
    // Only witnessed binding advice needs this owner read. Other usage sources
    // publish independently, and an unavailable catalog never fabricates a remedy.
        if (compose().results.some(slice => slice.coach?.findings.some(finding => finding.detectorId === 'mcp_overhead'
        && finding.currentness === 'current' && finding.evidence.some(ref => ref.kind === 'mcp_usage')))) {
        const { readMcpServerCatalog } = await import('./apiMcpServerCatalog');
        mcpCatalog = await readMcpServerCatalog(context.accountLifetime.scope, signal, () => requireCurrent(context, signal));
        requireCurrent(context, signal);
        publish();
        }
        return compose();
    } finally { unwatchNightHours?.(); }

    function applyCoachPreferences(batch: UsageQueryBatchResult, howYouWork: Awaited<ReturnType<typeof readHowYouWorkEvidence>>): UsageQueryBatchResult {
        const openedByQuery = new Map(howYouWork.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
        const settingsState = readRegisteredStorageState();
        const preferences = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults }).usageCoachPreferencesV1;
        const nowMs = Date.now();
        const results = batch.results.map(slice => {
            const opened = openedByQuery.get(slice.key);
            if (!slice.coach) return slice;
            const proposals = !opened || opened.detail.status === 'unknown' ? [] : buildUsageCoachRemedies({ findings: slice.coach.findings.filter(finding => finding.remedy === null),
                composition: opened.detail.coach?.composition ?? [], sessions: opened.sessions,
                mcpUsage: opened.detail.coach?.detail?.mcpUsage ?? [], ...(mcpCatalog ? { mcpCatalog } : {}),
                serverId: context.accountLifetime.scope.serverId, accountId: context.accountLifetime.scope.accountId });
            const coach = proposals.length === 0 ? slice.coach : admitUsageCoachRemedies(slice.coach,
                [...(opened?.detail.coach?.admittedRemedies ?? []), ...proposals]);
            const preferred = applyUsageCoachPreferences(coach, preferences, nowMs);
            return sameStrictJsonValue(preferred, slice.coach) ? slice : { ...slice, coach: preferred };
        });
        return results.every((slice, index) => slice === batch.results[index]) ? batch : UsageQueryBatchResultSchema.parse({ ...batch, results });
    }
}

type AccountResourceOwner = Readonly<{ store: PluginUiResourceStore; invalidate(): void; readSessionInput: SessionInputReader }>;
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
    // Allowances belong to this Account, not a page's accounting batch. Keep
    // their latest Resource revision across navigation, including zero views.
    // New query ranges still read their own history; these facts seed the body
    // until that replacement answers, rather than claiming its range is read.
    let allowance: Pick<UsageQueryBatchResult['results'][number], 'key' | 'requestedQuery' | 'shownQuery' | 'quota' | 'sources' | 'pending'> | undefined;
    // Queries move between route batches as visible widgets register. These
    // are the same Account Resource's accounting facts, independent of batch membership.
    const accountingByQuery = new Map<string, Pick<UsageQueryBatchResult['results'][number],
        'key' | 'requestedQuery' | 'shownQuery' | 'accounting' | 'sources' | 'pending'>>();
    const sessionInputs = new Map<string, { seq: number | undefined; basis: string; needsAdmission: boolean;
        value?: SessionInputEvidence; read: Promise<SessionInputEvidence | null> }>();
    const readSessionState = (id: string) => {
        const state = readRegisteredStorageState();
        const session = state && areServerAccountScopesEqual(state.profileScope, lifetime.scope) ? state.sessions[id] : undefined;
        return session && (!session.serverId || areServerProfileIdentifiersEquivalent(session.serverId, lifetime.scope.serverId)) ? session : undefined;
    };
    const readEvidenceBasis = (id: string) => {
        const session = readSessionState(id);
        return JSON.stringify([session?.seq, session?.metadataVersion, session?.agentStateVersion,
            session?.metadataLayoutVersion, session?.encryptionMode, session?.encryptedContentAvailability, session?.access]);
    };
    const listeners = new Set<(event: ResourceSubscriptionEvent) => void>();
    const owner = {
        readSessionInput(sessionId, load) {
            requireCurrent(sharedContext);
            const seq = readSessionState(sessionId)?.seq;
            const basis = readEvidenceBasis(sessionId);
            const retained = sessionInputs.get(sessionId);
            if (retained && retained.basis === basis && !retained.needsAdmission) return retained.read;
            const assertCurrent = () => {
                requireCurrent(sharedContext, evidenceAbort.signal);
                if (sessionInputs.get(sessionId) !== entry || readEvidenceBasis(sessionId) !== basis || entry.needsAdmission) {
                    throw Object.assign(new Error('Usage Session evidence changed'), { code: 'usage_session_evidence_changed' });
                }
            };
            const entry: NonNullable<ReturnType<typeof sessionInputs.get>> = { seq, basis, needsAdmission: false,
                read: Promise.resolve<SessionInputEvidence | null>(null) };
            sessionInputs.set(sessionId, entry);
            entry.read = load(assertCurrent, evidenceAbort.signal, retained?.seq === seq ? retained?.value : undefined).then(value => {
                assertCurrent();
                if (value) entry.value = value;
                // Missing versions and incomplete/failed reads remain retryable.
                if ((seq === undefined || !value?.completeMessageCoverage) && sessionInputs.get(sessionId) === entry) sessionInputs.delete(sessionId);
                return value;
            }).catch(error => {
                if (sessionInputs.get(sessionId) === entry) sessionInputs.delete(sessionId);
                if (error && typeof error === 'object' && 'code' in error && error.code === 'usage_session_evidence_changed') return null;
                throw error;
            });
            return entry.read;
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
                const retained = entry.getSnapshot().value;
                const ownPrevious = retained ? decodeUsageQueryResource(retained) : undefined;
                const queries = normalizeUsageQueryBatchInput(reference.input).queries;
                const previousByKey = new Map(ownPrevious?.results.map(slice => [slice.key, slice]));
                const previousSlices = queries.flatMap(query => {
                    const key = getUsageQueryKey(query);
                    const slice = previousByKey.get(key) ?? accountingByQuery.get(key);
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
                    const first = batch.results[0];
                    if (first) allowance = { key: first.key, requestedQuery: first.requestedQuery, shownQuery: first.shownQuery,
                        quota: first.quota, sources: first.sources.filter(source => source.source === 'quota' || source.source.startsWith('quota:')),
                        pending: first.sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:')) && source.status === 'pending') };
                    for (const slice of batch.results) if (slice.accounting
                        && slice.sources.some(source => source.source === 'accounting' && source.status !== 'pending' && source.status !== 'not_loaded')) {
                        accountingByQuery.set(slice.key, { key: slice.key, requestedQuery: slice.requestedQuery, shownQuery: slice.shownQuery,
                            accounting: slice.accounting, sources: slice.sources.filter(source => source.source === 'accounting'), pending: false });
                    }
                    const current = entry.getSnapshot().value;
                    // Reconcile each revision against the same entry's admitted
                    // value so unrelated slices keep their selected references.
                    const reconciled = retainUsageQueryResultReferences(batch, ownPrevious);
                    const currentBatch = current ? decodeUsageQueryResource(current) : undefined;
                    const value = retainUsageQueryResultReferences(reconciled, currentBatch);
                    // Reuse the entry's bytes as well as its decoded value. A
                    // terminal read commonly repeats its last progress revision.
                    if (current && value === currentBatch) return current;
                    const bytes = new TextEncoder().encode(JSON.stringify(value));
                    const digest = await computePluginUiArtifactSha256Digest(bytes);
                    requireCurrent(sharedContext, options?.signal);
                    const content = { contentType: 'application/json', bytes, digest } as const;
                    decodedValues.set(content, value);
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
                const result = await executeUsageAction('usage.query', reference.input, {
                    query: (input, actionContext) => readUiUsageQueryBatch(sharedContext, input, actionContext.signal, previous,
                        { onProgress: batch => {
                            queuedProgress = batch;
                            drainProgress();
                        } }),
                }, { signal: options?.signal });
                requireCurrent(sharedContext, options?.signal);
                if (!result.ok) {
                    if (['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface'].includes(result.errorCode)) {
                        allowance = undefined;
                        accountingByQuery.clear();
                    }
                    throw Object.assign(new Error(result.error), { code: result.errorCode });
                }
                // The final value supersedes any progress revision that has not
                // started materializing yet. Finish only the in-flight digest.
                queuedProgress = null;
                await progressContent;
                return await contentFor(UsageQueryBatchResultSchema.parse(result.result));
            },
            async watchResource(reference, listener, options) {
                requireCurrent(sharedContext, options?.signal);
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                listeners.add(listener);
                const dispose = () => { listeners.delete(listener); options?.signal?.removeEventListener('abort', dispose); };
                options?.signal?.addEventListener('abort', dispose, { once: true });
                return { dispose };
            },
        } }),
        invalidate() {
            if (!lifetime.isCurrent()) return;
            for (const listener of [...listeners]) listener({ version: 1, subscriptionId: 'usage-query', kind: 'invalidated', digest: INVALIDATION_DIGEST });
        },
    } satisfies AccountResourceOwner;
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
            // Wakes require fresh Session admission. Complete raw input remains
            // reusable only after that admission proves the same seq and mode.
            if (event.source === 'connected' || event.changeKinds === undefined || event.changeKinds.includes('session')) {
                if (event.entityIds === undefined || event.source === 'connected' || event.changeKinds === undefined) {
                    sessionInputs.forEach(entry => { entry.needsAdmission = true; });
                } else event.entityIds.forEach(id => {
                    const entry = sessionInputs.get(id);
                    if (entry) entry.needsAdmission = true;
                });
            }
            syncQualifiedSubscriptions();
            owner.invalidate();
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
        observedFeatures = features;
        owner.invalidate();
    });
    const unwatchState = subscribeUsageQueryStateInvalidation(() => {
        syncQualifiedSubscriptions();
        owner.invalidate();
    });
    const unwatchCredentials = subscribeHomeCredentialMutations(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
        if (event.kind === 'credentials_set' && event.credentials
            && resolveAuthCredentialsScopeKey(event.credentials) === resolveAuthCredentialsScopeKey(sharedContext.credentials)) return;
        owner.store.dispose();
        evidenceAbort.abort();
        sessionInputs.clear();
        accountingByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    lifetime.onRetire(() => {
        owner.store.dispose();
        evidenceAbort.abort();
        sessionInputs.clear();
        accountingByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        listeners.clear();
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    return owner.store;
}

// Decode once per admitted immutable Resource value so independent consumers
// select the same slice reference. No response or request lifetime lives here.
const decodedValues = new WeakMap<ResourceContent, UsageQueryBatchResult>();
export function decodeUsageQueryResource(value: ResourceContent): UsageQueryBatchResult {
    const existing = decodedValues.get(value);
    if (existing) return existing;
    const decoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes)));
    decodedValues.set(value, decoded);
    return decoded;
}
