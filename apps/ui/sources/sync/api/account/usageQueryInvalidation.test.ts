import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { getUsageProjectionNextReadAtMs, getUsageQueryMachineInvalidationKey, observeUsageProjection, subscribeUsageQueryStateInvalidation } from './usageQueryInvalidation';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';

afterEach(() => { vi.restoreAllMocks(); });

it('refreshes quota acquisition for connected-service entities and the legacy broad signal', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const serverId = 'service-quota-currentness.test';
    const observation = observeUsageProjection({ serverId, initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; }, nextReadAtMs: () => Number.POSITIVE_INFINITY });
    try {
        await vi.advanceTimersByTimeAsync(0);
        for (const [index, change] of [
            buildConnectedServicesAccountChangeV1({ pluginId: 'acme.accounts', localId: 'service-a' }),
            buildConnectedServicesAccountChangeV1(),
        ].entries()) {
            publishHomeAccountChange(serverId, [change.entityId], { changeKinds: ['account'], usageQueryAffects: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(reads).toBe(index + 1);
        }
        publishHomeAccountChange(serverId, ['self']);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(3);
        publishHomeAccountChange(serverId, ['self'], { changeKinds: ['account'], usageQueryAffects: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(3);
    } finally { observation.dispose(); vi.useRealTimers(); }
});

it('reconsiders existing accounts when their Usage capability arrives, but not when only its title changes', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const previous = storage.getState();
    const scope = { serverId: 'usage-capability.test', accountId: 'account' };
    const service = { pluginId: 'acme.meter', localId: 'meter' };
    storage.setState({ profileScope: scope, profile: { ...previous.profile, connectedAccountsV4: [{
        ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
    }] } });
    const install = (capabilities: string[], title = 'Meter') => installConnectedAccountDescriptorProjection({
        scopeKey: 'capability', status: 'ready', conflicts: [], errorReason: null,
        descriptors: [{ id: service.localId, serviceId: service.localId, pluginId: service.pluginId, title, provenance: 'external',
            sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
                outcomeReconciliation: 'none', fields: [] }] }, capabilities,
            availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }],
    });
    install([]);
    let invalidations = 0;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidations++; });
    try {
        install(['usage']);
        expect(invalidations).toBe(1);
        install(['usage'], 'Renamed meter');
        expect(invalidations).toBe(1);
        install([]);
        expect(invalidations).toBe(2);
    } finally {
        release?.();
        installConnectedAccountDescriptorProjection({ scopeKey: 'capability', status: 'loading', conflicts: [], errorReason: null, descriptors: [] });
        storage.setState({ profile: previous.profile, profileScope: previous.profileScope });
    }
});

it('keeps a healthy current-server quota reader idle for 120 seconds and ignores unrelated exact wakes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const serverId = 'idle-current-usage.test';
    const observation = observeUsageProjection({ serverId, initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; },
        nextReadAtMs: () => getUsageProjectionNextReadAtMs({ consecutiveErrors: 0 }) });
    try {
        for (let index = 0; index < 30; index++) {
            publishHomeAccountChange(serverId, ['unrelated-session'], { changeKinds: ['session'] });
            await vi.advanceTimersByTimeAsync(4_000);
        }
        expect(reads).toBe(0);
        publishHomeAccountChange(serverId, ['self', 'unrelated-session', 'machine-a'], {
            changeKinds: ['account', 'session', 'machine'], usageQueryAffects: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(0);
        publishHomeAccountChange(serverId, ['provider-account-usage'], {
            changeKinds: ['account'], usageQueryAffects: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        publishHomeAccountChange(serverId, ['self']);
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
    } finally { observation.dispose(); vi.useRealTimers(); }
});

it.each(['usage', 'usage-sources-invalidated'] as const)('still refreshes Usage readers for a scoped %s socket wake', async type => {
    const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
    let reads = 0;
    const observation = observeUsageProjection({
        serverId: 'usage-scoped-wake.test', initialReadCompleted: true,
        busy: () => false, read: async () => { reads++; }, nextReadAtMs: () => Number.POSITIVE_INFINITY,
    });
    try {
        await handleEphemeralSocketUpdate({
            sourceServerId: 'usage-scoped-wake.test',
            update: type === 'usage'
                ? { type, id: null, key: 'agent:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: 1_000 }
                : { type, machineId: 'machine', installationId: 'installation' },
            addActivityUpdate: () => {}, addMachineActivityUpdate: () => {},
            getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {},
        });
        expect(reads).toBe(1);
    } finally { observation.dispose(); }
});

it('observes a completed initial read without repeating it and still reads on invalidation and expiry', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let deadline = Date.now() + 30_000;
    const observation = observeUsageProjection({
        serverId: 'completed-usage-read.test', initialReadCompleted: true, busy: () => false,
        read: async () => { reads++; deadline = Number.POSITIVE_INFINITY; },
        nextReadAtMs: () => deadline,
    });
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(0);
        observation.invalidate();
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        deadline = Date.now() + 30_000;
        observation.reconcile();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads).toBe(2);
    } finally {
        observation.dispose();
        vi.useRealTimers();
    }
});

it.each(['presentation', 'read'] as const)('preserves a long %s deadline through the native timer boundary', async kind => {
    vi.useFakeTimers();
    const nativeMaximum = 2_147_483_647;
    const schedule = globalThis.setTimeout;
    // Node/browser timer overflow is an environment boundary, not a shorter owner deadline.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) =>
        schedule(callback, ms !== undefined && ms > nativeMaximum ? 1 : ms, ...args));
    const deadline = Date.now() + nativeMaximum + 100;
    let readDeadline = deadline;
    let reads = 0;
    let publications = 0;
    const observation = observeUsageProjection({
        serverId: 'long-usage-deadline.test', busy: () => false,
        read: async () => { reads++; if (reads > 1) readDeadline = Number.POSITIVE_INFINITY; },
        nextReadAtMs: () => kind === 'read' ? readDeadline : Number.POSITIVE_INFINITY,
        presentationDeadlineMs: () => kind === 'presentation' ? deadline : undefined,
        publish: () => { publications++; },
    });
    try {
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(nativeMaximum - 100);
        expect(reads).toBe(1);
        expect(publications).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(kind === 'read' ? 2 : 1);
        expect(publications).toBe(kind === 'presentation' ? 1 : 0);
    } finally {
        observation.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});

it('keeps presence heartbeats from changing the usage Resource machine invalidation key', () => {
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    const machine = createMachineFixture({ id: 'machine', activeAt: 1_900_000_000_000, updatedAt: 1_900_000_000_000 });
    const key = getUsageQueryMachineInvalidationKey({ [machine.id]: machine }, machine.activeAt!, scope);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, activeAt: machine.activeAt! + 1, updatedAt: machine.updatedAt + 1 },
    }, machine.activeAt!, scope)).toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed' } },
    }, machine.activeAt!, scope)).not.toBe(key);
    expect(getUsageQueryMachineInvalidationKey({
        [machine.id]: { ...machine, revokedAt: machine.activeAt },
    }, machine.activeAt!, scope)).toBe(key); // Coverage labels consume identity/name only.
});

it('keys pool selection by its resolved machine and Session evidence by only its hosting machines', () => {
    const nowMs = 1_900_000_000_000;
    const scope = { serverId: 'usage-machine-consumers.test', accountId: 'account-a' };
    const machines = Object.fromEntries(['a', 'b', 'c'].map(id => [id, createMachineFixture({ id, activeAt: nowMs })]));
    const consumers = { includeMachineNames: false, poolMachineFilters: [[]], sessionMachineIds: [] };
    const key = getUsageQueryMachineInvalidationKey(machines, nowMs, scope, consumers);
    expect(getUsageQueryMachineInvalidationKey({ ...machines,
        a: { ...machines.a!, metadata: { ...machines.a!.metadata!, displayName: 'Renamed' } },
        d: createMachineFixture({ id: 'd', activeAt: nowMs }),
    }, nowMs, scope, consumers)).toBe(key); // The pool remains ambiguous; neither name is quota evidence.
    const two = { ...machines, c: { ...machines.c!, active: false, activeAt: 1 } };
    expect(getUsageQueryMachineInvalidationKey(two, nowMs, scope, consumers)).toBe(key);
    const one = { ...two, b: { ...machines.b!, active: false, activeAt: 1 } };
    expect(getUsageQueryMachineInvalidationKey(one, nowMs, scope, consumers)).not.toBe(key);
    const sessionConsumers = { poolMachineFilters: [], sessionMachineIds: ['a'] };
    const sessionKey = getUsageQueryMachineInvalidationKey(machines, nowMs, scope, sessionConsumers);
    expect(getUsageQueryMachineInvalidationKey(two, nowMs, scope, sessionConsumers)).toBe(sessionKey);
    expect(getUsageQueryMachineInvalidationKey({ ...machines, a: { ...machines.a!, active: false, activeAt: 1 } }, nowMs, scope, sessionConsumers)).not.toBe(sessionKey);
    expect(getUsageQueryMachineInvalidationKey({ ...machines, a: { ...machines.a!, replacedByMachineId: 'b' } }, nowMs, scope, sessionConsumers)).not.toBe(sessionKey);
});

it('ignores equivalent Profile and Settings refreshes but invalidates changed quota inputs', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const previous = storage.getState();
    const scope = { serverId: 'usage-invalidation.test', accountId: 'account-a' };
    storage.setState({ profileScope: scope, settingsScope: scope,
        profile: { ...previous.profile, connectedAccountsV4: [{
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
            status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
        }] } });
    let invalidations = 0;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidations++; });
    try {
        for (let index = 0; index < 8; index++) {
            const state = storage.getState();
            storage.setState({ profileScope: { ...scope }, settingsScope: { ...scope },
                profile: { ...state.profile, connectedAccountsV4: structuredClone(state.profile.connectedAccountsV4),
                    connectedAccountGroupsV4: structuredClone(state.profile.connectedAccountGroupsV4) },
                settings: { ...state.settings, featureToggles: { ...state.settings.featureToggles } } });
        }
        expect(invalidations).toBe(0);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, lastUsedAt: Date.now(),
        })) } }));
        expect(invalidations).toBe(0);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => account.revisionSemantics === 'revisioned'
            ? { ...account, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz_replaced' } : account) } }));
        expect(invalidations).toBe(1);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, status: 'needs_reauth' as const,
        })) } }));
        expect(invalidations).toBe(2);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, configurationReady: true, configurationRevision: 'configuration-replaced',
        })) } }));
        expect(invalidations).toBe(3);
        storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account => ({
            ...account, ref: { ...account.ref, accountId: 'replacement-account' },
        })) } }));
        expect(invalidations).toBe(4);
        const state = storage.getState();
        storage.setState({ settings: { ...state.settings, experiments: !state.settings.experiments } });
        expect(invalidations).toBe(5);
        storage.setState({ settingsScope: { ...scope, accountId: 'other-account' } });
        expect(invalidations).toBe(6);
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [] } });
        expect(invalidations).toBe(7);
    } finally {
        release?.();
        storage.setState({ profile: previous.profile, profileScope: previous.profileScope,
            settings: previous.settings, settingsScope: previous.settingsScope });
    }
});

it('does not reread machine details for unrelated store notifications, but observes presence expiry', async () => {
    const { storage } = await import('@/sync/domains/state/storageStore');
    let nowMs = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const machine = createMachineFixture({ id: 'machine', activeAt: nowMs, updatedAt: nowMs });
    const metadata = machine.metadata;
    let detailReads = 0;
    Object.defineProperty(machine, 'metadata', { enumerable: true, get() { detailReads++; return metadata; } });
    const previousMachines = storage.getState().machines;
    const previousReady = storage.getState().isDataReady;
    const previousSettingsScope = storage.getState().settingsScope;
    const previousProfileScope = storage.getState().profileScope;
    storage.setState({ machines: { [machine.id]: machine }, profileScope: { serverId: 'usage-invalidation.test', accountId: 'account-a' } });
    let invalidated = false;
    const release = subscribeUsageQueryStateInvalidation(() => { invalidated = true; }, () => ({
        poolMachineFilters: [[machine.id]], sessionMachineIds: [],
    }));
    try {
        detailReads = 0;
        for (let index = 0; index < 128; index++) storage.setState({ isDataReady: !storage.getState().isDataReady });
        const unrelatedDetailReads = detailReads;
        expect(invalidated).toBe(false);
        const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
        if (deadline === null) throw new Error('Expected witnessed presence deadline');
        nowMs = deadline;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(true);
        expect(detailReads).toBeGreaterThan(unrelatedDetailReads);
        console.info(JSON.stringify({ unrelatedStoreRevisions: 128, unrelatedMachineDetailReads: unrelatedDetailReads, expiryDetailReads: detailReads - unrelatedDetailReads }));
        expect(unrelatedDetailReads).toBe(0);
        invalidated = false;
        nowMs = machine.activeAt!;
        storage.setState({ isDataReady: !storage.getState().isDataReady });
        expect(invalidated).toBe(true); // A backward clock can make the same rows online again.
        invalidated = false;
        storage.setState({ machines: { [machine.id]: { ...machine, activeAt: nowMs + 1, updatedAt: nowMs + 1 } } });
        expect(invalidated).toBe(false);
        const beforeScopeChange = detailReads;
        storage.setState({ settingsScope: { serverId: 'usage-invalidation.test', accountId: 'other-account' } });
        expect(invalidated).toBe(true);
        expect(detailReads).toBe(beforeScopeChange);
    } finally {
        release?.();
        storage.setState({ machines: previousMachines, isDataReady: previousReady, settingsScope: previousSettingsScope, profileScope: previousProfileScope });
    }
});
