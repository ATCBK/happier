import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useApplyVoiceSettingsEdit } = await import('./settingsWriters');
const { sync } = await import('@/sync/sync');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
afterEach(async () => { await account?.dispose(); account = null; });

describe('mounted Voice settings writer through Account CAS', () => {
    it('saves during initial version hydration and rebases consecutive edits on the server winner', async () => {
        const raw = { voiceSettingsV1: { providerId: 'local_direct' }, futureSetting: { keep: true } };
        let injectConflict = false;
        let conflicts = 0;
        const home = await createSecretSettingsTestHarness({ settings: settingsParse(raw), rawSettings: raw });
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
