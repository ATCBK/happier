import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useApplyVoiceSettingsEdit } = await import('./settingsWriters');
const { sync } = await import('@/sync/sync');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
afterEach(async () => { await account?.dispose(); account = null; });

describe('mounted Voice settings writer through Account CAS', () => {
    it('retains the private compound intent through Inbox approval without serializing editor snapshots', async () => {
        const home = await createSecretSettingsTestHarness({ voiceEnabled: true, serverIdentityId: 'srv_voice_edit', settings: settingsParse({
            voice: { providerId: 'local_direct', providers: {
                'fixture.voice/retained': { schemaVersion: 99, config: { token: 'PRIVATE-VOICE-EDITOR-CREDENTIAL' } },
            } },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        account = home;
        const hook = await renderHook(() => useApplyVoiceSettingsEdit());
        let pending: Promise<void> | undefined;
        try {
            const before = storage.getState().settings.voice;
            const next = { ...before, privacy: { ...before.privacy, recentMessagesCount: 8 },
                welcome: { ...before.welcome, enabled: true } };
            await act(async () => { pending = hook.getCurrent()(before, next); });
            await vi.waitFor(() => expect(home.artifacts.list()).toHaveLength(1));
            const approvalId = home.artifacts.list()[0]!.id;
            const body = home.artifacts.readPlainBody(approvalId);
            expect(body).not.toBeNull();
            expect(body).not.toContain('PRIVATE-VOICE-EDITOR-CREDENTIAL');
            expect(JSON.parse(body!)).toMatchObject({ actionId: 'settings.set', actionArgs: { anchor: 'voiceConversations.edit', value: null } });
            expect(home.settingsWrites).toHaveLength(0);
            expect(home.persistedSettings.voice).toEqual(before);
            await act(async () => { home.replaceSettings(settingsParse({ ...home.persistedSettings, analyticsOptOut: true })); });
            await decideApprovalAsInbox(home.scope.serverId, approvalId, 'approve');
            await act(async () => { await pending; });
            expect(home.persistedSettings).toMatchObject({ analyticsOptOut: true,
                voice: { welcome: { enabled: true }, privacy: { recentMessagesCount: 8 } } });
            expect(home.settingsWrites).toHaveLength(1);
        } finally {
            await hook.unmount();
            await pending?.catch(() => {});
        }
    });

    it('keeps a compound edit atomic and private, and retires its captured Account writer', async () => {
        const home = await createSecretSettingsTestHarness({ voiceEnabled: true, settings: settingsParse({
            voice: { providerId: 'local_direct' },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        account = home;
        const hook = await renderHook(() => useApplyVoiceSettingsEdit());
        try {
            const writer = hook.getCurrent();
            const before = storage.getState().settings.voice;
            const next = { ...before, welcome: { ...before.welcome, enabled: true },
                privacy: { ...before.privacy, recentMessagesCount: 8 } };
            const writes = home.settingsWrites.length;
            await act(async () => { await writer(before, next); });
            expect(home.settingsWrites).toHaveLength(writes + 1);
            expect(home.persistedSettings.voice).toMatchObject({ welcome: { enabled: true }, privacy: { recentMessagesCount: 8 } });
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui' as const, authority: 'present_user' as const,
                serverId: home.scope.serverId, expectedAccountId: home.scope.accountId };
            expect(await executor.execute('settings.get', { anchor: 'voiceConversations.edit' }, context))
                .toMatchObject({ ok: false });
            const listed = await executor.execute('settings.list', { pageId: 'voiceConversations' }, context);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
            if (!listed.ok) throw new Error('Missing Voice settings discovery');
            expect(JSON.stringify(listed.result)).not.toContain('voiceConversations.edit');
            expect(await executor.execute('settings.set', { anchor: 'voiceConversations.edit', value: null }, context))
                .toMatchObject({ ok: false });
            expect(await executor.execute('settings.set', { anchor: 'voiceConversations.edit', value: { before, next } }, context))
                .toMatchObject({ ok: false });
            expect(await executor.execute('settings.set', { anchor: 'voiceConversations.edit', value: null }, {
                ...context, surface: 'agent', authority: 'account_automation',
            })).toMatchObject({ ok: false });
            expect(home.settingsWrites).toHaveLength(writes + 1);
            await act(async () => { storage.setState({ settingsScope: { ...home.scope, accountId: 'retired-account' } }); });
            await expect(writer(before, next)).rejects.toThrow();
            expect(home.settingsWrites).toHaveLength(writes + 1);
        } finally { await hook.unmount(); }
    });

    it('refuses the whole compound editor intent when settings.set is disabled while settings.invoke remains allowed', async () => {
        const home = await createSecretSettingsTestHarness({ voiceEnabled: true, settings: settingsParse({
            voice: { providerId: 'local_direct' },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        account = home;
        const hook = await renderHook(() => useApplyVoiceSettingsEdit());
        try {
            const before = storage.getState().settings.voice;
            const next = { ...before, welcome: { ...before.welcome, enabled: !before.welcome.enabled },
                privacy: { ...before.privacy, recentMessagesCount: 8 } };
            await expect(hook.getCurrent()(before, next)).rejects.toThrow();
            expect(home.settingsWrites).toHaveLength(0);
            expect(home.persistedSettings.voice).toEqual(before);
            const adjacent = await createDefaultActionExecutor().execute('settings.invoke', {
                anchor: 'voiceConversations.ttsPreviewStop',
            }, { surface: 'ui', authority: 'present_user', serverId: home.scope.serverId, expectedAccountId: home.scope.accountId });
            expect(adjacent, JSON.stringify(adjacent)).toMatchObject({ ok: true, result: { status: 'completed' } });
            expect(home.settingsWrites).toHaveLength(0);
        } finally { await hook.unmount(); }
    });

    it('saves during initial version hydration and rebases consecutive edits on the server winner', async () => {
        const raw = { voiceSettingsV1: { providerId: 'local_direct' }, futureSetting: { keep: true },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } };
        let injectConflict = false;
        let conflicts = 0;
        const home = await createSecretSettingsTestHarness({ voiceEnabled: true, settings: settingsParse(raw), rawSettings: raw });
        account = home;
        const request = home.request.getMockImplementation()!;
        home.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                // Real producer bytes are admitted by the same strict request schema as the Home route.
                const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                if (injectConflict) {
                    injectConflict = false;
                    const winner = { ...home.persistedSettings, futureSetting: raw.futureSetting, analyticsOptOut: true };
                    home.replaceSettings(winner, { version: input.expectedVersion + 1, publish: false });
                    conflicts++;
                }
            }
            return await request(url, init);
        });
        await expect(sync.mutateAccountSettingsOnce({
            expectedSettingsScope: home.scope, expectedSettingsVersion: null,
            mutate: current => ({ settings: { ...current, strictMutationShouldNotApply: true }, value: undefined }),
        })).rejects.toThrow('requires a valid expected version');
        expect(home.persistedRawSettings?.strictMutationShouldNotApply).toBeUndefined();
        const hook = await renderHook(() => useApplyVoiceSettingsEdit());
        try {
            const before = storage.getState().settings.voice;
            const first = { ...before, privacy: { ...before.privacy, recentMessagesCount: 8 } };
            await act(async () => {
                storage.setState({ settingsVersion: null });
                expect(storage.getState().settingsVersion).toBeNull();
                await hook.getCurrent()(before, first);
            });
            expect(home.persistedSettings.voice.privacy.recentMessagesCount).toBe(8);
            // The same rendered editor survives an acknowledgement and another client's CAS update.
            injectConflict = true;
            const second = { ...before, privacy: { ...before.privacy, shareToolNames: !before.privacy.shareToolNames } };
            await hook.getCurrent()(before, second);
            const saved = home.persistedSettings;
            expect(saved.voice.privacy.recentMessagesCount).toBe(8);
            expect(saved.voice.privacy.shareToolNames).toBe(second.privacy.shareToolNames);
            expect(saved.analyticsOptOut).toBe(true);
            expect(home.persistedRawSettings?.futureSetting).toEqual({ keep: true });
            expect(conflicts).toBe(1);
            expect(home.settingsWrites.length).toBeGreaterThan(0);
        } finally { await hook.unmount(); }
    });
});
