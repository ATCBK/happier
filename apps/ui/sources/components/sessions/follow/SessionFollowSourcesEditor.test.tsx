import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { standardCleanup } from '@/dev/testkit';

import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const api = vi.hoisted(() => ({
    list: vi.fn(),
    remove: vi.fn(),
    set: vi.fn(),
}));
const preparation = vi.hoisted(() => ({ run: vi.fn() }));
const picker = vi.hoisted(() => ({ open: vi.fn() }));
const connectivity = vi.hoisted(() => ({ online: true }));
const useServerScopedMachine = vi.hoisted(() => vi.fn());
const followState = vi.hoisted(() => ({
    rows: {} as Record<string, unknown>,
    machinesByServer: {} as Record<string, readonly Machine[]>,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/api/session/sessionFollowSourcesApi', () => ({
    listSessionFollowSources: api.list,
    removeSessionFollowSource: api.remove,
    setSessionFollowSource: api.set,
}));
vi.mock('./prepareSessionFollowSourceKey', () => ({ prepareSessionFollowSourceKey: preparation.run }));
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isServerReachabilityNetworkAllowed: () => connectivity.online,
    subscribeServerReachabilityNetworkAllowed: () => () => undefined,
}));
vi.mock('./openSessionFollowDestinationPicker', () => ({ openSessionFollowSourcePicker: picker.open }));
vi.mock('@/text', () => ({ t: (key: string, params?: { title?: string }) => params?.title ? `${key}:${params.title}` : key }));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSessionListRowsByServerId: () => followState.rows,
        useServerScopedMachine,
    });
});

import { SessionFollowSourcesEditor } from './SessionFollowSourcesEditor';
let accountFixture: Awaited<ReturnType<typeof activateStorageAccountScope>> | undefined;
afterEach(() => { standardCleanup(); accountFixture?.dispose(); accountFixture = undefined; });

function findSourceRow(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    sourceSessionId: string,
) {
    const testID = `session-follow-source-${sourceSessionId}`;
    return screen.listRows(testID).find((node) => (
        node.props.testID === testID && typeof node.props.subtitle === 'string'
    )) ?? null;
}

/**
 * The web Pressable host carries `disabled` only while it is disabled, so the
 * component-level boolean is read from the outermost element with the testID.
 */
function readControlDisabled(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    testID: string,
): boolean | undefined {
    return screen.findAllByTestId(testID)[0]?.props.disabled;
}

describe('SessionFollowSourcesEditor', () => {
    beforeEach(async () => {
        accountFixture = await activateStorageAccountScope({ serverId: 'home-a', accountId: 'follow-account' });
        api.list.mockReset();
        api.remove.mockReset();
        api.set.mockReset();
        preparation.run.mockReset();
        picker.open.mockReset();
        preparation.run.mockResolvedValue({ kind: 'waiting', reason: 'runner_unreachable' });
        connectivity.online = true;
        followState.rows = {};
        followState.machinesByServer = {};
        useServerScopedMachine.mockImplementation((serverId: string | null | undefined, machineId: string) => (
            (followState.machinesByServer[serverId ?? ''] ?? []).find((machine) => machine.id === machineId) ?? null
        ));
    });

    it('retries preparation for a retained committed edge after the picker lifetime', async () => {
        const listed = createDeferred<Readonly<{
            kind: 'ok';
            value: {
                sources: Array<{
                    sourceSessionId: string;
                    destinationSessionId: string;
                    deliveryState: 'eligible';
                    hasPendingUpdates: boolean;
                }>;
            };
        }>>();
        connectivity.online = true;
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        // Mount/passive-effect scheduling may legitimately coalesce or repeat
        // the same authoritative read. Keep the boundary response stable for
        // the lifetime of this pending observation.
        api.list.mockReturnValue(listed.promise);
        preparation.run.mockResolvedValueOnce({ kind: 'waiting', reason: 'runner_unreachable' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        // Resolve the canonical committed-edge read inside React's update boundary.
        // This keeps the test independent of passive-effect scheduling while still
        // proving that a retained edge (rather than the picker callback) initiates
        // source-key preparation.
        await act(async () => {
            listed.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-a', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await listed.promise;
        });
        expect(useServerScopedMachine).toHaveBeenCalledWith('home-a', 'runner-a');
        expect(useServerScopedMachine.mock.results.at(-1)?.value?.id).toBe('runner-a');
        await vi.waitFor(() => {
            expect(preparation.run).toHaveBeenCalledWith({
                serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
            });
            expect(findSourceRow(screen, 'source-a')?.props.subtitle)
                .toBe('session.follow.sources.waitingRuntime');
        });
        expect(screen.getTextContent()).toContain('common.retry');
        await act(async () => { screen.findByTestId('session-follow-source-source-a-retry')?.props.onPress?.(); await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(2);

        api.remove.mockResolvedValueOnce({ kind: 'ok', value: { changed: true } });
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [] } });
        const removeButton = screen.findByTestId('session-follow-source-source-a-remove');
        await act(async () => { removeButton?.props.onPress?.(); await Promise.resolve(); });
        expect(api.remove).toHaveBeenCalledWith({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        });
        await screen.unmount();
    });

    it('prepares a source again when a removed committed edge is later re-added', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        preparation.run.mockResolvedValue({ kind: 'prepared' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));
        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        expect(preparation.run).toHaveBeenCalledTimes(1);

        api.remove.mockResolvedValueOnce({ kind: 'ok', value: { changed: true } });
        currentSources = [];
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            screen.findByTestId('session-follow-source-add')?.props.onPress?.();
            const onClose = picker.open.mock.calls.at(-1)?.[2];
            expect(onClose).toBeTypeOf('function');
            await onClose(undefined);
        });
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));
        await screen.unmount();
    });

    it('retains preparation across a same-Machine reconnect but prepares again for a replacement Machine', async () => {
        const activeAt = Date.now();
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn' as const,
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [relation] } });
        preparation.run.mockResolvedValue({ kind: 'prepared' });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt,
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        const destination = createSessionFixture({ id: 'destination-a' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => {
            expect(preparation.run).toHaveBeenCalledTimes(1);
            expect(findSourceRow(screen, 'source-a')?.props.subtitle)
                .toBe('session.follow.sources.nextTurn');
        });

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            kind: 'ephemeral_session_runner',
            active: false,
            activeAt: activeAt + 1,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(1);

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 2,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).toHaveBeenCalledTimes(1);

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-b',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 3,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));
        expect(preparation.run).toHaveBeenLastCalledWith({
            serverId: 'home-a', sourceSessionId: 'source-a', destinationSessionId: 'destination-a',
        });
        await screen.unmount();
    });

    it('ignores a delayed preparation result from the previous destination Machine', async () => {
        const activeAt = Date.now();
        const firstMachinePreparation = createDeferred<Readonly<{ kind: 'prepared' }>>();
        const replacementMachinePreparation = createDeferred<Readonly<{
            kind: 'waiting';
            reason: 'source_key_unavailable';
        }>>();
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn',
            deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        preparation.run
            .mockReturnValueOnce(firstMachinePreparation.promise)
            .mockReturnValueOnce(replacementMachinePreparation.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt,
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        const destination = createSessionFixture({ id: 'destination-a' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));

        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-b',
            kind: 'ephemeral_session_runner',
            active: true,
            activeAt: activeAt + 1,
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        await screen.update(<SessionFollowSourcesEditor
            destination={destination}
            serverId="home-a"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));

        await act(async () => {
            firstMachinePreparation.resolve({ kind: 'prepared' });
            await firstMachinePreparation.promise;
        });
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceKeyPreparing');

        await act(async () => {
            replacementMachinePreparation.resolve({ kind: 'waiting', reason: 'source_key_unavailable' });
            await replacementMachinePreparation.promise;
        });
        // An unavailable source key is a settled answer, not the transient "waiting" copy.
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceSessionKeyUnavailable');
        await screen.unmount();
    });

    it('reloads only its exact Home/destination when a committed Session invalidation or reconnect wake arrives', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn' as const,
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId={null}
        />);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull());
        const callsAfterMount = api.list.mock.calls.length;

        publishHomeAccountChange('home-b', ['destination-a']);
        publishHomeAccountChange('home-a', ['unrelated-session']);
        await act(async () => { await Promise.resolve(); });
        expect(api.list).toHaveBeenCalledTimes(callsAfterMount);

        currentSources = [];
        await act(async () => {
            publishHomeAccountChange('home-a', ['destination-a']);
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            // Reconnect/cursor-reset wakes have no exact entity page and must
            // conservatively reload this mounted exact-Home projection.
            publishHomeAccountChange('home-a');
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull());
        await screen.unmount();
    });

    it('keeps Stop updates available during preparation and rejects the old result after the edge is re-created', async () => {
        const firstPreparation = createDeferred<Readonly<{ kind: 'prepared' }>>();
        const relation = {
            sourceSessionId: 'source-a',
            destinationSessionId: 'destination-a',
            mode: 'next_turn' as const,
            deliveryState: 'eligible' as const,
            hasPendingUpdates: false,
        };
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'e2ee' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };
        let currentSources = [relation];
        api.list.mockImplementation(async () => ({ kind: 'ok', value: { sources: currentSources } }));
        api.remove.mockImplementation(async () => {
            currentSources = [];
            return { kind: 'ok', value: { changed: true } };
        });
        preparation.run
            .mockReturnValueOnce(firstPreparation.promise)
            .mockResolvedValueOnce({ kind: 'waiting', reason: 'source_key_unavailable' });

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(1));

        const stop = screen.findByTestId('session-follow-source-source-a-remove');
        expect(stop?.props.disabled).toBe(false);
        await act(async () => {
            stop?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a')).toBeNull());

        currentSources = [relation];
        await act(async () => {
            screen.findByTestId('session-follow-source-add')?.props.onPress?.();
            const onClose = picker.open.mock.calls.at(-1)?.[2];
            expect(onClose).toBeTypeOf('function');
            await onClose(undefined);
        });
        await vi.waitFor(() => expect(preparation.run).toHaveBeenCalledTimes(2));

        await act(async () => {
            firstPreparation.resolve({ kind: 'prepared' });
            await firstPreparation.promise;
        });
        expect(findSourceRow(screen, 'source-a')?.props.subtitle)
            .toBe('session.follow.sources.sourceSessionKeyUnavailable');
        await screen.unmount();
    });

    it('offers wake mode only for the exact destination Machine capability and persists the selected mode', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a',
            destinationSessionId: 'destination-a',
            mode: 'next_turn',
            deliveryState: 'eligible',
            hasPendingUpdates: false,
        }] } });
        api.set.mockResolvedValue({ kind: 'ok', value: { changed: true } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
        };
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-a')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-source-source-a')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findByTestId('session-follow-source-source-a-mode-next_turn')?.props['aria-checked']).toBe(true);
        expect(screen.findByTestId('session-follow-source-source-a-mode-wake_on_human_change')?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('session-follow-source-source-a-mode-next_turn')?.props.accessibilityState).toMatchObject({ checked: true });
        expect(screen.findByTestId('session-follow-source-source-a-mode-wake_on_human_change')?.props.accessibilityState).toMatchObject({ checked: false });
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-mode-wake_on_human_change')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).toHaveBeenCalledWith({
            serverId: 'home-a',
            destinationSessionId: 'destination-a',
            sourceSessionId: 'source-a',
            mode: 'wake_on_human_change',
        });
        await screen.unmount();

        api.set.mockClear();
        followState.machinesByServer['home-a'] = [createMachineFixture({
            id: 'runner-a',
            active: true,
            activeAt: Date.now(),
            operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
        })];
        const contextOnlyRuntime = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        // Without the wake capability the row offers no press action at all; stopping
        // updates keeps its own labelled control instead of moving onto the row body.
        await vi.waitFor(() => expect(contextOnlyRuntime.findByTestId('session-follow-source-source-a-remove')).not.toBeNull());
        const contextOnlyRow = findSourceRow(contextOnlyRuntime, 'source-a');
        expect(contextOnlyRow?.props.detail).toBeUndefined();
        expect(contextOnlyRow?.props.onPress).toBeUndefined();
        // The label announces exactly what the row shows — its title and its delivery
        // status — and nothing more: an inert row must not announce an action it does
        // not perform, and the status must not be dropped.
        expect(contextOnlyRow?.props.accessibilityLabel)
            .toBe(`${contextOnlyRow?.props.title}. session.follow.sources.nextTurn`);
        expect(api.set).not.toHaveBeenCalled();
        await contextOnlyRuntime.unmount();
    });

    it('names each Stop updates control with its source session identity', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn', deliveryState: 'eligible', hasPendingUpdates: false },
            { sourceSessionId: 'source-b', destinationSessionId: 'destination-a', mode: 'next_turn', deliveryState: 'eligible', hasPendingUpdates: false },
        ] } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', metadata: { name: 'Alpha source', path: '/repo/alpha' }, encryptionMode: 'plain' }),
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', metadata: { name: 'Beta source', path: '/repo/beta' }, encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true } },
            })],
        };
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-b-remove')).not.toBeNull());
        const labels = ['source-a', 'source-b'].map((id) => screen.findByTestId(`session-follow-source-${id}-remove`)?.props.accessibilityLabel);
        expect(labels).toEqual([
            'session.follow.sources.stopForSource:Alpha source',
            'session.follow.sources.stopForSource:Beta source',
        ]);
        expect(new Set(labels).size).toBe(2);
        await screen.unmount();
    });

    it('never paints sources returned for a previous exact destination after the destination changes', async () => {
        const first = createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<{ sourceSessionId: string; destinationSessionId: string; deliveryState: 'eligible'; hasPendingUpdates: boolean }> } }>>();
        const second = createDeferred<Readonly<{ kind: 'ok'; value: { sources: Array<{ sourceSessionId: string; destinationSessionId: string; deliveryState: 'eligible'; hasPendingUpdates: boolean }> } }>>();
        api.list
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        const firstDestination = createSessionFixture({ id: 'destination-a' });
        const secondDestination = createSessionFixture({ id: 'destination-b' });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={firstDestination}
            serverId="home-a"
            destinationMachineId={null}
        />);

        await screen.update(<SessionFollowSourcesEditor
            destination={secondDestination}
            serverId="home-b"
            destinationMachineId={null}
        />);
        await act(async () => {
            second.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-b', destinationSessionId: 'destination-b', deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await second.promise;
        });
        expect(screen.findByTestId('session-follow-source-source-b')).not.toBeNull();

        await act(async () => {
            first.resolve({ kind: 'ok', value: { sources: [{
                sourceSessionId: 'source-a', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false,
            }] } });
            await first.promise;
        });
        expect(screen.findByTestId('session-follow-source-source-b')).not.toBeNull();
        expect(screen.findByTestId('session-follow-source-source-a')).toBeNull();
        await screen.unmount();
    });

    it('ignores a completed removal from the previous destination while the current destination mutation remains active', async () => {
        const oldRemoval = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        const currentModeUpdate = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        const focused = vi.fn();
        api.list.mockImplementation(async (input: Readonly<{ sessionId: string }>) => ({
            kind: 'ok',
            value: {
                sources: input.sessionId === 'destination-a'
                    ? [{
                        sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn' as const,
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }]
                    : [{
                        sourceSessionId: 'source-b', destinationSessionId: 'destination-b', mode: 'next_turn' as const,
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }],
            },
        }));
        api.remove.mockReturnValueOnce(oldRemoval.promise);
        api.set.mockReturnValueOnce(currentModeUpdate.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
            'home-b': {
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
            'home-b': [createMachineFixture({
                id: 'runner-b', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
        };

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />, {
            createNodeMock: (element) => ({ focus: () => focused((element.props as { testID?: string }).testID) }),
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a-remove')).not.toBeNull());
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });

        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-b' })}
            serverId="home-b"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-b')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-b')?.props.onPress?.();
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId('session-follow-source-source-b-mode-wake_on_human_change')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.set).toHaveBeenCalledWith({
            serverId: 'home-b',
            destinationSessionId: 'destination-b',
            sourceSessionId: 'source-b',
            mode: 'wake_on_human_change',
        });
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            oldRemoval.resolve({ kind: 'ok', value: { changed: true } });
            await oldRemoval.promise;
            await Promise.resolve();
        });
        expect(focused).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            currentModeUpdate.resolve({ kind: 'ok', value: { changed: true } });
            await currentModeUpdate.promise;
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(false));
        await screen.unmount();
    });

    it('ignores a failed mode update from the previous destination while the current destination removal remains active', async () => {
        const oldModeUpdate = createDeferred<Readonly<{ kind: 'error'; error: string }>>();
        const currentRemoval = createDeferred<Readonly<{ kind: 'ok'; value: { changed: true } }>>();
        api.list.mockImplementation(async (input: Readonly<{ sessionId: string }>) => ({
            kind: 'ok',
            value: {
                sources: input.sessionId === 'destination-a'
                    ? [{
                        sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn' as const,
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }]
                    : [{
                        sourceSessionId: 'source-b', destinationSessionId: 'destination-b', mode: 'next_turn' as const,
                        deliveryState: 'eligible' as const, hasPendingUpdates: false,
                    }],
            },
        }));
        api.set.mockReturnValueOnce(oldModeUpdate.promise);
        api.remove.mockReturnValueOnce(currentRemoval.promise);
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
            'home-b': {
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
                },
            })],
            'home-b': [createMachineFixture({
                id: 'runner-b', active: true, operationProtocolCapabilities: {
                    sessionFollow: { contextV1: true },
                },
            })],
        };

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).not.toBeNull());
        await act(async () => {
            findSourceRow(screen, 'source-a')?.props.onPress?.();
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-mode-wake_on_human_change')?.props.onPress?.();
            await Promise.resolve();
        });

        await screen.update(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-b' })}
            serverId="home-b"
            destinationMachineId="runner-b"
        />);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-b-remove')).not.toBeNull());
        await act(async () => {
            screen.findByTestId('session-follow-source-source-b-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        expect(api.remove).toHaveBeenCalledWith({
            serverId: 'home-b',
            destinationSessionId: 'destination-b',
            sourceSessionId: 'source-b',
        });
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            oldModeUpdate.resolve({ kind: 'error', error: 'old_destination_failed' });
            await oldModeUpdate.promise;
            await Promise.resolve();
        });
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);

        await act(async () => {
            currentRemoval.resolve({ kind: 'ok', value: { changed: true } });
            await currentRemoval.promise;
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(false));
        await screen.unmount();
    });

    it('retries the exact failed Stop following instead of reloading the list', async () => {
        const relation = {
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', mode: 'next_turn' as const,
            deliveryState: 'eligible' as const, hasPendingUpdates: false,
        };
        let removed = false;
        api.list.mockImplementation(async () => ({
            kind: 'ok',
            value: { sources: removed ? [] : [relation] },
        }));
        api.remove.mockImplementationOnce(async () => ({ kind: 'error', error: 'unavailable' }));
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({ id: 'runner-a', active: true })],
        };

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-source-source-a-remove')).not.toBeNull());

        await act(async () => {
            screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-follow-sources-error')).not.toBeNull());

        // A definite rejection of Stop following is not retried by listing again.
        api.remove.mockImplementationOnce(async () => {
            removed = true;
            return { kind: 'ok', value: { changed: true } };
        });
        await act(async () => {
            screen.findByTestId('session-follow-sources-error')?.props.onPress?.();
            await Promise.resolve();
        });
        await vi.waitFor(() => expect(api.remove).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(findSourceRow(screen, 'source-a')).toBeNull());
        expect(screen.findByTestId('session-follow-sources-error')).toBeNull();
        await screen.unmount();
    });

    it('keeps loaded source choices visible but disables mutations while offline', async () => {
        connectivity.online = false;
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-a', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId={null}
        />);

        await act(async () => {});
        expect(findSourceRow(screen, 'source-a')).not.toBeNull();
        expect(readControlDisabled(screen, 'session-follow-source-source-a-remove')).toBe(true);
        expect(readControlDisabled(screen, 'session-follow-source-add')).toBe(true);
        expect(screen.findByTestId('session-follow-sources-offline')).not.toBeNull();

        await act(async () => { screen.findByTestId('session-follow-source-source-a-remove')?.props.onPress?.(); });
        expect(api.remove).not.toHaveBeenCalled();
        connectivity.online = true;
        await screen.unmount();
    });

    it('reads an eligible and an archived relation the same way for sight and for a screen reader', async () => {
        // The committed-edge read may be re-issued when the mount effect settles,
        // so answer every call rather than depending on effect scheduling.
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [
            { sourceSessionId: 'source-a', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false },
            { sourceSessionId: 'source-b', destinationSessionId: 'destination-a', deliveryState: 'paused_archived', hasPendingUpdates: false },
        ] } });
        followState.rows = {
            'home-a': {
                'source-a': createSessionListRenderableSessionFixture({ id: 'source-a', encryptionMode: 'plain' }),
                'source-b': createSessionListRenderableSessionFixture({ id: 'source-b', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => {
            expect(screen.findByTestId('session-follow-source-source-a')).not.toBeNull();
        });

        // The accessibility label restates the visible status, so an eligible row
        // must not announce the Account-Follow word "Following" while the subtitle
        // a sighted person reads says the source is included in the next turn.
        await vi.waitFor(() => {
            const eligible = findSourceRow(screen, 'source-a');
            expect(eligible?.props.subtitle).toBe('session.follow.sources.nextTurn');
            expect(eligible?.props.accessibilityLabel).toContain('session.follow.sources.nextTurn');
            expect(eligible?.props.accessibilityLabel).not.toContain('session.follow.following');
        });

        // Archive pauses the relation between two Sessions; the Account Follow
        // sentence about "this session" would describe the wrong relationship.
        expect(findSourceRow(screen, 'source-b')?.props.subtitle)
            .toBe('session.follow.sources.pausedArchived');
        await screen.unmount();
    });

    it('does not enter Runner key preparation for a known plaintext source', async () => {
        api.list.mockResolvedValueOnce({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-plain', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        followState.rows = {
            'home-a': {
                'source-plain': createSessionListRenderableSessionFixture({ id: 'source-plain', encryptionMode: 'plain' }),
            },
        };
        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: { sessionFollow: { contextV1: true } },
            })],
        };

        const screen = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);

        await act(async () => { await Promise.resolve(); });
        expect(preparation.run).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-follow-source-source-plain')).not.toBeNull();
        await screen.unmount();
    });

    it('uses the exact destination Machine to distinguish waiting from an unsupported runtime without preparing', async () => {
        api.list.mockResolvedValue({ kind: 'ok', value: { sources: [{
            sourceSessionId: 'source-e2ee', destinationSessionId: 'destination-a', deliveryState: 'eligible', hasPendingUpdates: false,
        }] } });
        followState.rows = {
            'home-a': {
                'source-e2ee': createSessionListRenderableSessionFixture({ id: 'source-e2ee', encryptionMode: 'e2ee' }),
            },
        };

        const unavailable = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(
            findSourceRow(unavailable, 'source-e2ee')?.props.subtitle,
        ).toBe('session.follow.sources.waitingRuntime'));
        expect(preparation.run).not.toHaveBeenCalled();
        await unavailable.unmount();

        followState.machinesByServer = {
            'home-a': [createMachineFixture({
                id: 'runner-a',
                kind: 'ephemeral_session_runner',
                active: true,
                activeAt: Date.now(),
                operationProtocolCapabilities: {},
            })],
        };
        const unsupported = await renderSettingsView(<SessionFollowSourcesEditor
            destination={createSessionFixture({ id: 'destination-a' })}
            serverId="home-a"
            destinationMachineId="runner-a"
        />);
        await vi.waitFor(() => expect(
            findSourceRow(unsupported, 'source-e2ee')?.props.subtitle,
        ).toBe('session.follow.sources.unsupported'));
        expect(preparation.run).not.toHaveBeenCalled();
        await unsupported.unmount();
    });
});
