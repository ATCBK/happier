import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { listServersForVoiceTool } from './serversList';

const initialState = storage.getState();
const initialServerId = getActiveServerSnapshot().serverId;

describe('listServersForVoiceTool', () => {
    beforeEach(() => {
        storage.setState(initialState, true);
        storage.setState({ settings: {
            ...initialState.settings,
            voice: { ...initialState.settings.voice, privacy: {
                ...initialState.settings.voice.privacy, shareDeviceInventory: true,
            } },
        } });
    });
    afterEach(async () => {
        storage.setState(initialState, true);
        await setActiveServerId(initialServerId);
    });

    it('prefers saved server profile names over raw server ids', async () => {
        storage.setState({
            concurrentSessionListCacheByServerId: { 'server-b': { serverName: 'Review Server' } },
            ordinarySessionListMembershipByServerId: { 'server-b': ['s-review'] },
            sessionListRowsByServerId: {
                'server-b': { 's-review': createSessionListRenderableSessionFixture({ id: 's-review', metadata: null }) },
            },
        });
        const active = await upsertServerProfile({ serverUrl: 'http://server-a.local', name: 'Primary Server' });
        await setActiveServerId(active.id);

        expect(await listServersForVoiceTool({ limit: 10 })).toEqual({
            items: [
                { serverId: active.id, label: 'Primary Server' },
                { serverId: 'server-b', label: 'Review Server' },
            ],
        });
    });

    it('falls back to human-friendly generic labels instead of raw server ids', async () => {
        storage.setState({
            concurrentSessionListCacheByServerId: {
                'server-b': { serverName: null }, 'server-c': { serverName: null },
            },
            ordinarySessionListMembershipByServerId: {
                'server-b': ['s-review'], 'server-c': ['s-mobile'],
            },
            sessionListRowsByServerId: {
                'server-b': { 's-review': createSessionListRenderableSessionFixture({ id: 's-review', metadata: null }) },
                'server-c': { 's-mobile': createSessionListRenderableSessionFixture({ id: 's-mobile', metadata: null }) },
            },
        });
        const active = await upsertServerProfile({ serverUrl: 'http://unnamed-home.local', name: '' });
        await setActiveServerId(active.id);

        expect(await listServersForVoiceTool({ limit: 10 })).toEqual({
            items: [
                { serverId: active.id, label: 'Current server' },
                { serverId: 'server-b', label: 'Connected server 1' },
                { serverId: 'server-c', label: 'Connected server 2' },
            ],
        });
    });
});
