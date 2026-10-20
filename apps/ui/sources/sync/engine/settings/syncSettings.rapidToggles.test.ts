import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { Settings } from '@/sync/domains/settings/settings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Prepare the real settings/store graph outside the behavior-test deadline.
const { syncSettings, applySettingsLocalDelta } = await import('./syncSettings');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const settingsOwner = await import('@/sync/domains/settings/settings');
const settingsNormalizationOwner = await import('@/sync/domains/settings/accountSettingsNormalization');
const { storage } = await import('@/sync/domains/state/storage');
const { loadPendingAccountSettings, savePendingAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');

const keys = [
    'transcriptMessageCopyActionEnabled', 'transcriptMessageForkActionEnabled',
    'transcriptMessageRollbackActionEnabled', 'transcriptMessageSelectionEnabled',
    'transcriptMessagePinActionEnabled', 'transcriptMessageSavePromptActionEnabled',
    'transcriptMessagePluginActionsEnabled', 'transcriptMessageMakeRepeatableActionEnabled',
] as const satisfies readonly (keyof Settings)[];
afterEach(async () => { await harness.reset(); });
// reset retires the HTTP port as well as fixture Homes; restore that real
// system boundary before each case rather than letting later cases hit DNS.
beforeEach(() => { installHomeGovernanceBoundaries(harness); });

describe('rapid Account settings intents', () => {
    it('does not echo an unchanged stale preference during refresh or an unrelated write', async () => {
        const serverId = await harness.addHome({ name: 'Stale client', serverUrl: 'https://stale-client.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        let raw: Record<string, unknown> = { keyboardShortcutsV2Enabled: false, analyticsOptOut: false };
        let version = 2;
        let pending: Partial<Settings> = {};
        // Another client has already restored the preference. This client's
        // older projection is not an intent to restore its stale value.
        storage.setState({ settingsScope: scope, settingsVersion: 1,
            settings: settingsParse({ keyboardShortcutsV2Enabled: true, analyticsOptOut: false }) });
        savePendingAccountSettings(scope, {});
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
        let posts = 0;
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            // Real HTTP boundary: accept exactly the current CAS version.
            const request = input as { expectedVersion: number; content: { t: 'plain'; v: Record<string, unknown> } };
            expect(request.expectedVersion).toBe(version);
            raw = request.content.v;
            posts++;
            return { body: { success: true, version: ++version } };
        } });
        const sync = () => syncSettings({ credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null, settingsScope: scope, pendingSettings: pending,
            getPendingSettings: () => pending, clearPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); } });
        await sync();
        expect(posts).toBe(0);
        expect(storage.getState().settings.keyboardShortcutsV2Enabled).toBe(false);
        // Recreate the stale projection before a real unrelated local intent.
        storage.setState({ settingsVersion: 1, settings: settingsParse({ keyboardShortcutsV2Enabled: true, analyticsOptOut: false }) });
        applySettingsLocalDelta({ expectedSettingsScope: scope, delta: { analyticsOptOut: true }, settingsSecretsKey: null,
            getPendingSettings: () => pending, setPendingSettings: next => { pending = next; }, schedulePendingSettingsFlush: () => {} });
        expect(pending).toEqual({ analyticsOptOut: true });
        await sync();
        expect(posts).toBe(1);
        expect(raw).toMatchObject({ keyboardShortcutsV2Enabled: false, analyticsOptOut: true });
        expect(pending).toEqual({});
        await sync();
        expect(posts).toBe(1);
        expect(storage.getState().settings.keyboardShortcutsV2Enabled).toBe(false);
    });

    it('parses a fetched Settings baseline only once before publication', async () => {
        const serverId = await harness.addHome({ name: 'Settings', serverUrl: 'https://settings-perf.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}) });
        savePendingAccountSettings(scope, {});
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { analyticsOptOut: true } }, version: 2 } });
        const parse = vi.spyOn(settingsOwner, 'settingsParse');
        try {
            await syncSettings({ credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
                encryption: null, settingsScope: scope, pendingSettings: {}, clearPendingSettings: () => {} });
            // Server + local-only normalization, then the canonical persistence parse.
            expect(parse).toHaveBeenCalledTimes(3);
            expect(storage.getState().settings.analyticsOptOut).toBe(true);
            expect(storage.getState().settingsVersion).toBe(2);
        } finally {
            parse.mockRestore();
        }
    });

    it('reads the Settings baseline while remote-alert projection is held and preserves a newer local edit', async () => {
        const serverId = await harness.addHome({ name: 'Bootstrap', serverUrl: 'https://bootstrap.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        const raw = { analyticsOptOut: true };
        const newerLocalDraftId = '11111111-1111-4111-8111-111111111111';
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}) });
        savePendingAccountSettings(scope, {});
        let release!: () => void;
        const remoteProjection = new Promise<void>(resolve => { release = resolve; });
        harness.answer(serverId, '/v1/push-tokens?projectionVersion=2', { status: 404, respondAfter: remoteProjection });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: raw }, version: 2 } });
        const normalize = vi.spyOn(settingsNormalizationOwner, 'normalizeAccountSettingsForLocalStorage');
        const inFlight = syncSettings({ credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null, settingsScope: scope, pendingSettings: {}, republishRemoteAlertPolicy: true,
            clearPendingSettings: () => {} });
        try {
            await vi.waitFor(() => expect(harness.requestsFor('/v2/account/settings')).toHaveLength(1));
            await vi.waitFor(() => expect(normalize).toHaveBeenCalledTimes(1));
            expect(storage.getState().settingsVersion).toBe(1);
            storage.getState().applySettingsLocal({ newSessionOrdinaryEntryDraftId: newerLocalDraftId });
            expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBe(newerLocalDraftId);
        } finally {
            release();
            try { await inFlight; } finally { normalize.mockRestore(); }
        }
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
        expect(storage.getState().settingsVersion).toBe(2);
        expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBe(newerLocalDraftId);
    });

    it('retains seven new intents across an earlier acknowledgement and rebases their next flush on a CAS winner', async () => {
        const serverId = await harness.addHome({ name: 'Toggles', serverUrl: 'https://toggles.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        let raw: Record<string, unknown> = Object.fromEntries(keys.map(key => [key, false]));
        let version = 1;
        let pending: Partial<Settings> = {};
        storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
        savePendingAccountSettings(scope, {});
        const toggle = (key: typeof keys[number]) => applySettingsLocalDelta({
            expectedSettingsScope: scope, delta: { [key]: true }, settingsSecretsKey: null,
            getPendingSettings: () => pending, setPendingSettings: next => { pending = next; },
            // Hold only the clock/persistence boundary: these are not on disk yet.
            schedulePendingSettingsFlush: () => {},
        });
        let releaseFirst!: () => void;
        const firstAck = new Promise<void>(resolve => { releaseFirst = resolve; });
        let firstIssued!: () => void;
        const firstPost = new Promise<void>(resolve => { firstIssued = resolve; });
        let posts = 0;
        let conflicts = 0;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            // HTTP boundary fixture: this is the canonical writer's plain request shape.
            const request = input as { expectedVersion: number; content: { t: 'plain'; v: Record<string, unknown> } };
            posts++;
            if (posts === 2) { raw = { ...raw, analyticsOptOut: true }; version++; }
            if (request.expectedVersion !== version) {
                conflicts++;
                return { status: 409, body: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: raw } } };
            }
            raw = request.content.v;
            version++;
            if (posts === 1) firstIssued();
            return { body: { success: true, version }, ...(posts === 1 ? { respondAfter: firstAck } : {}) };
        } });
        const flush = () => syncSettings({ credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null, settingsScope: scope, pendingSettings: pending,
            getPendingSettings: () => pending,
            clearPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); },
        });
        toggle(keys[0]);
        savePendingAccountSettings(scope, pending);
        const inFlight = flush();
        await firstPost;
        for (const key of keys.slice(1)) toggle(key);
        releaseFirst();
        await inFlight;
        // The earlier acknowledgement must not erase the still-unflushed intents.
        expect(Object.keys(pending).sort()).toEqual(keys.slice(1).sort());
        savePendingAccountSettings(scope, pending);
        await flush();
        expect(pending).toEqual({});
        expect(conflicts).toBe(1);
        const response = await harness.request('https://toggles.example/v2/account/settings');
        const readback = await response.json() as { content: { t: 'plain'; v: Record<string, unknown> } };
        expect(readback.content.v).toMatchObject(Object.fromEntries(keys.map(key => [key, true])));
        expect(readback.content.v.analyticsOptOut).toBe(true);
    });

    it('keeps a same-key reversal pending and reloadable while its earlier value is acknowledged', async () => {
        const serverId = await harness.addHome({ name: 'Reversal', serverUrl: 'https://reversal.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        const key = keys[0];
        let raw: Record<string, unknown> = { [key]: false };
        let version = 1;
        let pending: Partial<Settings> = {};
        storage.setState({ settingsScope: scope, settingsVersion: version, settings: settingsParse(raw) });
        savePendingAccountSettings(scope, {});
        const toggle = (value: boolean) => applySettingsLocalDelta({
            expectedSettingsScope: scope, delta: { [key]: value }, settingsSecretsKey: null,
            getPendingSettings: () => pending, setPendingSettings: next => { pending = next; },
            schedulePendingSettingsFlush: () => {},
        });
        let release!: () => void;
        const acknowledgement = new Promise<void>(resolve => { release = resolve; });
        let issued!: () => void;
        const firstPost = new Promise<void>(resolve => { issued = resolve; });
        let posts = 0;
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: { content: { t: 'plain', v: raw }, version } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const request = input as { expectedVersion: number; content: { t: 'plain'; v: Record<string, unknown> } };
            expect(request.expectedVersion).toBe(version);
            raw = request.content.v;
            version++;
            posts++;
            if (posts === 1) issued();
            return { body: { success: true, version }, ...(posts === 1 ? { respondAfter: acknowledgement } : {}) };
        } });
        const credentials = { token: createAccountTokenForTests('owner', { currentAccount: true }) };
        const clearPendingSettings = (next: Partial<Settings>) => {
            pending = next;
            savePendingAccountSettings(scope, next);
        };
        toggle(true);
        savePendingAccountSettings(scope, pending);
        const inFlight = syncSettings({ credentials, encryption: null, settingsScope: scope,
            pendingSettings: pending, getPendingSettings: () => pending, clearPendingSettings });
        await firstPost;
        toggle(false);
        release();
        await inFlight;
        expect(storage.getState().settings[key]).toBe(false);
        expect(pending).toEqual({ [key]: false });
        // A fresh pending-state read must recover the surviving intent, without the live getter.
        pending = loadPendingAccountSettings(scope);
        expect(pending).toEqual({ [key]: false });
        await syncSettings({ credentials, encryption: null, settingsScope: scope,
            pendingSettings: pending, clearPendingSettings });
        expect(pending).toEqual({});
        const response = await harness.request('https://reversal.example/v2/account/settings');
        const readback = await response.json() as { content: { t: 'plain'; v: Record<string, unknown> } };
        expect(readback.content.v[key]).toBe(false);
    });

    it('retires recovered organization-only pending roots without importing them or writing Account settings', async () => {
        const serverId = await harness.addHome({ name: 'Retired pending', serverUrl: 'https://retired-pending.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}) });
        // Recovered/JavaScript ingress can still contain a historical root that typed editors cannot author.
        let pending: Partial<Settings> & { pinnedSessionKeysV1?: string[] } = {
            pinnedSessionKeysV1: [`${serverId}:pending-session`],
        };
        harness.answer(serverId, '/v2/account/settings', { body: {
            content: { t: 'plain', v: { analyticsOptOut: false } }, version: 1,
        } });

        await syncSettings({
            credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null,
            settingsScope: scope,
            pendingSettings: pending,
            getPendingSettings: () => pending,
            clearPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); },
        });

        expect(pending).toEqual({});
        expect(loadPendingAccountSettings(scope)).toEqual({});
        expect(harness.requestsFor('/v2/account/settings')).toHaveLength(1);
        expect(harness.requests.filter(request => request.path.startsWith('/v2/session-organization'))).toEqual([]);
        expect(storage.getState().settingsVersion).toBe(1);
    });

    it('commits a current preference while retiring a recovered organization root from the same pending delta', async () => {
        const serverId = await harness.addHome({ name: 'Mixed pending', serverUrl: 'https://mixed-pending.example', accountId: 'owner', currentAccount: true });
        const scope = { serverId, accountId: 'owner' };
        storage.setState({ settingsScope: scope, settingsVersion: 1, settings: settingsParse({}) });
        let pending: Partial<Settings> & { pinnedSessionKeysV1?: string[] } = {
            analyticsOptOut: true,
            pinnedSessionKeysV1: [`${serverId}:pending-session`],
        };
        let raw: Record<string, unknown> = { analyticsOptOut: false };
        let version = 1;
        const written: Record<string, unknown>[] = [];
        harness.answer(serverId, '/v2/account/settings', { select: () => ({ body: {
            content: { t: 'plain', v: raw }, version,
        } }) });
        harness.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(request.expectedVersion).toBe(version);
            if (request.content?.t !== 'plain') throw new Error('Expected plain Account settings');
            raw = request.content.v;
            written.push(raw);
            return { body: { success: true, version: ++version } };
        } });

        await syncSettings({
            credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) },
            encryption: null,
            settingsScope: scope,
            pendingSettings: pending,
            getPendingSettings: () => pending,
            clearPendingSettings: next => { pending = next; savePendingAccountSettings(scope, next); },
        });

        expect(written).toEqual([{ analyticsOptOut: true }]);
        expect(pending).toEqual({});
        expect(loadPendingAccountSettings(scope)).toEqual({});
        expect(harness.requests.filter(request => request.path.startsWith('/v2/session-organization'))).toEqual([]);
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
        expect(storage.getState().settingsVersion).toBe(2);
    });
});
