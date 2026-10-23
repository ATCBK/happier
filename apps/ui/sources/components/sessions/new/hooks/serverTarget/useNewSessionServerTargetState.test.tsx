import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import * as serverProfiles from '@/sync/domains/server/serverProfiles';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { readUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const serverProfilesState = {
    value: [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
    ] as Array<Pick<serverProfiles.ServerProfile, 'id' | 'name' | 'serverUrl' | 'lastUsedAt'>
        & Partial<Pick<serverProfiles.ServerProfile, 'serverIdentityId'>>>,
};

let locks: ReturnType<typeof installWebLockManagerMock>;
let profileReads: import('vitest').MockInstance<typeof serverProfiles.listServerProfiles>;
const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];

async function publishServerProfiles() {
    await seedPersistedHomeProfilesForTests({ activeServerId: serverProfilesState.value[0]!.id,
        profiles: serverProfilesState.value.map(profile => ({ ...profile, createdAt: 1, updatedAt: 1, source: 'manual' })),
    });
    for (const profile of serverProfilesState.value) {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: `account:${profile.id}` })).toString('base64url')}.signature`;
        const write = await TokenStorage.setCredentialsForServerUrlWithRollback(profile.serverUrl,
            { serverId: profile.serverIdentityId ?? profile.id }, { token });
        if (!write) throw new Error('The selected test Home must have usable Account credentials');
        credentialWrites.push(write);
    }
}

type ProbeProps = Readonly<{
    activeServerSnapshot?: Readonly<{
        serverId: string;
        serverUrl: string;
        generation: number;
    }>;
    request: Readonly<{
        spawnServerIdParam?: string | null;
        persistedTargetServerId?: string | null;
    }>;
    settings?: Partial<Settings>;
    onState: (value: ReturnType<typeof useNewSessionServerTargetState>) => void;
}>;

const defaultServerSelectionSettings = {
    serverSelectionGroups: [
        { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' },
    ],
    serverSelectionActiveTargetKind: 'group',
    serverSelectionActiveTargetId: 'grp-dev',
} satisfies Partial<Settings>;

function buildSettings(overrides: Partial<Settings> = defaultServerSelectionSettings): Settings {
    return {
        ...settingsDefaults,
        ...overrides,
    };
}

function Probe(props: ProbeProps) {
    const state = useNewSessionServerTargetState({
        settings: buildSettings(props.settings),
        activeServerSnapshot: props.activeServerSnapshot ?? {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
        request: props.request,
    });
    React.useEffect(() => {
        props.onState(state);
    }, [props, state]);
    return null;
}

describe('useNewSessionServerTargetState', () => {
    beforeEach(async () => {
        locks = installWebLockManagerMock();
        serverProfilesState.value = [
            { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ];
        await publishServerProfiles();
        // Call-through observation: profile and credential decisions remain real.
        profileReads = vi.spyOn(serverProfiles, 'listServerProfiles');
    });

    afterEach(async () => {
        profileReads.mockRestore();
        for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
        locks.restore();
    });

    it('uses the admitted creation host Home without saved profiles or Account selection', async () => {
        const hook = await renderHook(() => useNewSessionServerTargetState({ settings: buildSettings(),
            serverProfiles: [], activeServerId: '', hostTargetServerId: 'https://embed-home.example', request: {} }));
        expect(hook.getCurrent().targetServerId).toBe('https://embed-home.example');
        expect(hook.getCurrent().allowedTargetServerIds).toEqual(['https://embed-home.example']);
        expect(hook.getCurrent().showServerPickerChip).toBe(false);
        await hook.unmount();
    });

    it('keeps the initial authoring Home when focused Home changes before draft persistence', async () => {
        const hook = await renderHook((activeServerId: string) => useNewSessionServerTargetState({
            settings: buildSettings(),
            activeServerId,
            request: {},
        }), { initialProps: 'server-b' });
        expect(hook.getCurrent().targetServerId).toBe('server-b');
        await hook.rerender('server-c');
        expect(hook.getCurrent().targetServerId).toBe('server-b');
        await hook.unmount();
    });

    it('preserves listServerProfiles ordering (does not reorder by lastUsedAt)', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);

        expect(captured.at(-1)!.serverProfiles.map((profile) => profile.id)).toEqual(['server-a', 'server-c', 'server-b']);
    });

    it('does not reload server profiles when only active server generation changes', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];
        const firstActiveServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        };

        const screen = await renderScreen(<Probe
                    activeServerSnapshot={firstActiveServerSnapshot}
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);
        // Credential availability has its own asynchronous profile census.
        // Settle that real owner before observing the generation-only update.
        await vi.waitFor(() => expect(readUsableHomeServerIds()).toEqual(['server-a', 'server-b', 'server-c']));
        await flushHookEffects();
        profileReads.mockClear();
        const initialServerProfiles = captured.at(-1)!.serverProfiles;

        await screen.update(<Probe
                        activeServerSnapshot={{
                            ...firstActiveServerSnapshot,
                            generation: 2,
                        }}
                        request={{}}
                        onState={(state) => captured.push(state)}
                    />);

        expect(profileReads).not.toHaveBeenCalled();
        expect(captured.at(-1)!.serverProfiles).toBe(initialServerProfiles);
    });

    it('derives allowed server ids from the current active settings target and resolves requested server inside that scope', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget?.kind).toBe('group');
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-c');
        expect(latest.targetServerName).toBe('Server C');
        expect(latest.showServerPickerChip).toBe(true);
    });

    it('reports an explicit route target outside the active scope and normalizes to the allowed Home', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-a',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.rejectedRequestedServerId).toBe('server-a');
        expect(latest.targetServerProfile?.id).toBe('server-b');
        expect(latest.showServerPickerChip).toBe(true);
    });

    it('uses the persisted target server when no route server target is present', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        persistedTargetServerId: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-c');
        expect(latest.targetServerName).toBe('Server C');
    });

    it.each(['deleted-profile', 'server-a'])('keeps an unavailable persisted Home fail-closed (%s)', async (persistedTargetServerId) => {
        const hook = await renderHook(() => useNewSessionServerTargetState({
            settings: buildSettings(), activeServerId: 'server-b', request: { persistedTargetServerId },
        }));
        expect(hook.getCurrent().allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(hook.getCurrent().targetServerId).toBeNull();
        expect(hook.getCurrent().rejectedRequestedServerId).toBe(persistedTargetServerId);
        await hook.unmount();
    });

    it('lets the route server target override the persisted target server', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-b',
                        persistedTargetServerId: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
    });

    it('honors an explicit server target without requiring the global active server to switch first', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    settings={{
                        serverSelectionGroups: [
                            { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' },
                        ],
                        serverSelectionActiveTargetKind: 'server',
                        serverSelectionActiveTargetId: 'server-b',
                    }}
                    request={{
                        spawnServerIdParam: 'server-b',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget?.kind).toBe('server');
        expect(latest.selectedServerTarget?.id).toBe('server-b');
        expect(latest.allowedTargetServerIds).toEqual(['server-b']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
        expect(latest.showServerPickerChip).toBe(false);
    });

    it('fails closed when device-global settings explicitly target a missing Home', async () => {
        serverProfilesState.value = [
            { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ];
        await publishServerProfiles();
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    settings={{
                        serverSelectionGroups: [],
                        serverSelectionActiveTargetKind: 'server',
                        serverSelectionActiveTargetId: 'server-c',
                    }}
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget).toBeNull();
        expect(latest.allowedTargetServerIds).toEqual([]);
        expect(latest.targetServerId).toBeNull();
        expect(latest.rejectedRequestedServerId).toBe('server-c');
    });

    it('targets identity-backed server ids while resolving the profile by its stable profile record', async () => {
        serverProfilesState.value = [
            { id: 'localhost-18829', serverIdentityId: 'srv_identity_a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        ];
        await publishServerProfiles();
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    activeServerSnapshot={{
                        serverId: 'srv_identity_a',
                        serverUrl: 'https://a.example.test',
                        generation: 1,
                    }}
                    settings={{
                        serverSelectionGroups: [],
                        serverSelectionActiveTargetKind: 'server',
                        serverSelectionActiveTargetId: 'localhost-18829',
                    }}
                    request={{ persistedTargetServerId: 'localhost-18829' }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.resolvedSettingsTarget.activeServerId).toBe('srv_identity_a');
        expect(latest.targetServerId).toBe('srv_identity_a');
        expect(latest.targetServerProfile?.id).toBe('localhost-18829');
        expect(latest.targetServerName).toBe('Server A');
    });

    it('resolves a route profile alias inside a group before choosing the active Home fallback', async () => {
        serverProfilesState.value = [
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
            { id: 'local-c', serverIdentityId: 'srv_identity_c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        ];
        await publishServerProfiles();
        const hook = await renderHook(() => useNewSessionServerTargetState({
            settings: buildSettings({
                ...defaultServerSelectionSettings,
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'local-c'], presentation: 'grouped' }],
            }),
            activeServerId: 'server-b',
            request: { spawnServerIdParam: 'local-c' },
        }));

        expect(hook.getCurrent().allowedTargetServerIds).toEqual(['server-b', 'srv_identity_c']);
        expect(hook.getCurrent().targetServerId).toBe('srv_identity_c');
        expect(hook.getCurrent().rejectedRequestedServerId).toBeNull();
        await hook.unmount();
    });
});
