import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '../../../dev/testkit/mocks/storage';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

const state = vi.hoisted(() => ({
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: true,
            },
        },
    },
    concurrentSessionListCacheByServerId: {},
    ordinarySessionListMembershipByServerId: {},
    sessionListRowsByServerId: {},
})) as {
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: boolean;
            };
        };
    };
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    ordinarySessionListMembershipByServerId: Record<string, readonly string[]>;
    sessionListRowsByServerId: Record<string, Record<string, unknown>>;
};

function createCachedSession(sessionId: string) {
    return buildSessionListRenderableFromSession({
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    });
}

installVoiceToolActionImplCommonModuleMocks({
    storage: async () => {
        const getSnapshot = () => ({
            settings: settingsParse(state.settings),
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
            ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
        } as StorageState);

        return createStorageModuleStub({
            // Boundary-only dynamic store stub: this action reads `settings` and the session list cache
            // directly from `storage.getState()`, so the test only models that contract surface.
            storage: Object.assign(
                ((selector?: (value: StorageState) => unknown) => {
                    const snapshot = getSnapshot();
                    return typeof selector === 'function' ? selector(snapshot) : snapshot;
                }) as UseBoundStore<StoreApi<StorageState>>,
                {
                    getState: getSnapshot,
                    getInitialState: getSnapshot,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                } satisfies Pick<StoreApi<StorageState>, 'getState' | 'getInitialState' | 'setState' | 'subscribe'> & {
                    destroy: () => void;
                },
            ),
        });
    },
});

describe('listServersForVoiceTool', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('prefers saved server profile names over raw server ids', async () => {
        state.settings.voice.privacy.shareDeviceInventory = true;
        state.concurrentSessionListCacheByServerId = { 'server-b': { serverName: 'Review Server' } };
        state.ordinarySessionListMembershipByServerId = { 'server-b': ['s-review'] };
        state.sessionListRowsByServerId = { 'server-b': { 's-review': createCachedSession('s-review') } };
        const active = await upsertServerProfile({ serverUrl: 'http://server-a.local', name: 'Primary Server' });
        await setActiveServerId(active.id);

        const { listServersForVoiceTool } = await import('./serversList');
        const result = await listServersForVoiceTool({ limit: 10 });

        expect(result).toEqual({
            items: [
                { serverId: active.id, label: 'Primary Server' },
                { serverId: 'server-b', label: 'Review Server' },
            ],
        });
    });

    it('falls back to human-friendly generic labels instead of raw server ids', async () => {
        state.settings.voice.privacy.shareDeviceInventory = true;
        state.concurrentSessionListCacheByServerId = {
            'server-b': { serverName: null },
            'server-c': { serverName: null },
        };
        state.ordinarySessionListMembershipByServerId = {
            'server-b': ['s-review'],
            'server-c': ['s-mobile'],
        };
        state.sessionListRowsByServerId = {
            'server-b': { 's-review': createCachedSession('s-review') },
            'server-c': { 's-mobile': createCachedSession('s-mobile') },
        };
        const active = await upsertServerProfile({ serverUrl: 'http://unnamed-home.local', name: '' });
        await setActiveServerId(active.id);

        const { listServersForVoiceTool } = await import('./serversList');
        const result = await listServersForVoiceTool({ limit: 10 });

        expect(result).toEqual({
            items: [
                { serverId: active.id, label: 'Current server' },
                { serverId: 'server-b', label: 'Connected server 1' },
                { serverId: 'server-c', label: 'Connected server 2' },
            ],
        });
    });
});
