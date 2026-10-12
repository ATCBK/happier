import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { Settings } from '@/sync/domains/settings/settings';

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

describe('rapid Account settings intents', () => {
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
});
