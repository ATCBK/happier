import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionMetadata } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';

import { useSessionDisplayNameSource, useSessionDisplayNameProjections } from './hooks';
import { readableSessionDisplayTitle, useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { getSessionWorkContextParts } from '@/utils/sessions/sessionUtils';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

afterEach(() => {
    standardCleanup();
});

describe('useSessionMetadata', () => {
    it('does not disclose a same-id live record from another Home', async () => {
        const previousState = storage.getState();
        try {
            const metadata = { host: 'home-b', path: '/b' };
            storage.setState({ sessions: { 's-1': createSessionFixture({ id: 's-1', serverId: 'home-a' }) } });
            const unavailable = await renderHook(() => useSessionMetadata('s-1', null));
            expect(unavailable.getCurrent()).toBeNull();
            await unavailable.unmount();
            const hook = await renderHook(() => useSessionMetadata('s-1', 'home-b'));
            expect(hook.getCurrent()).toBeNull();
            await act(async () => {
                storage.setState({ sessions: { 's-1': createSessionFixture({ id: 's-1', serverId: 'home-b', metadata }) } });
            });
            expect(hook.getCurrent()).toBe(metadata);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not re-render when non-metadata session fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata: Session['metadata'] = { flavor: 'codex', host: 'localhost', path: '/tmp/project' };
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    's-1': ({
                        id: 's-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                    } satisfies Session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionMetadata('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;

            expect(hook.getCurrent()).toBe(metadata);

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                active: false,
                                updatedAt: 2,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(metadata);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});

describe('useSessionDisplayNameSource', () => {
    it('preserves declared Agent identity from the real layout-1 row producer through the display source', async () => {
        const previousState = storage.getState();
        try {
            for (const agentId of ['opencode', 'acme.reviewer']) {
                const opened = createSessionFixture({ id: 'agent-context', serverId: 'home-b', metadataLayoutVersion: 1,
                    metadata: parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId } }, 1),
                    ownerMetadataView: { name: 'Release review', host: 'review-box', path: '/release', flavor: 'codex' } });
                const row = buildSessionListRenderableFromSession(opened);
                expect(getSessionWorkContextParts(row, 'home-b').agentId).toBe(agentId);
                // A same-id hydrated record on another Home must not supply this row's Agent.
                storage.setState({ sessions: { [opened.id]: createSessionFixture({ id: opened.id, serverId: 'home-a',
                    metadata: { path: '/wrong', host: 'wrong', flavor: 'claude' } }) },
                    sessionListRowsByServerId: { 'home-b': { [opened.id]: row } } });
                const hook = await renderHook(() => useSessionDisplayNameSource(opened.id, 'home-b'));
                const source = hook.getCurrent()!;
                expect(readSessionPresentationAgentId(source)).toBe(agentId);
                expect(getSessionWorkContextParts(source, 'home-b')).toMatchObject({ agentId, locationLabel: 'review-box' });
                expect(getSessionName(source, 'home-b')).toBe(getSessionName(row, 'home-b'));
                await act(async () => { storage.setState({ sessions: {} }); });
                expect(hook.getCurrent()?.metadata).toBe(source.metadata);
                await hook.unmount();
            }
        } finally { storage.setState(previousState); }
    });
    it('uses the sidebar display row when a same-Home live shell has not opened metadata', async () => {
        const previousState = storage.getState();
        try {
            const opened = createSessionFixture({ id: 'opened', serverId: 'home-b', encryptionMode: 'e2ee',
                metadataLayoutVersion: 1, metadata: { path: '', host: '' },
                ownerMetadataView: { name: 'Release review', host: 'review-box', path: '/release' } });
            const row = buildSessionListRenderableFromSession(opened);
            const shell = { ...opened, metadata: null, ownerMetadataView: null, encryptedContentAvailability: 'encrypted_access_pending' as const };
            storage.setState({ sessions: { opened: shell }, sessionListRowsByServerId: { 'home-b': { opened: row } } });
            const hook = await renderHook(() => useSessionDisplayTitles([{ serverId: 'home-b', sessionId: 'opened' }]));
            expect(hook.getCurrent()).toEqual([getSessionName(row, 'home-b')]);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('names opened Home-qualified list rows like the sidebar, including recipients and keyless untitled Sessions', async () => {
        const previousState = storage.getState();
        try {
            const opened = createSessionFixture({ id: 'opened', serverId: 'home-b', encryptionMode: 'e2ee',
                metadataLayoutVersion: 1, metadata: { path: '', host: '', summary: { text: 'Review release', updatedAt: 1 } },
                ownerMetadataView: { name: 'Review release', host: 'review-box', path: '/release' } });
            const recipient = createSessionFixture({ id: 'recipient', serverId: 'home-b', encryptionMode: 'e2ee',
                metadataLayoutVersion: 1, metadata: null, ownerMetadataView: null, accessLevel: 'view',
                encryptedContentAvailability: 'encrypted_access_pending', lockedDisplayTitle: 'Shared review' });
            const untitled = createSessionFixture({ id: 'untitled', serverId: 'home-b', metadata: null });
            const sessions = [opened, recipient, untitled];
            const rows = Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)]));
            storage.setState({ sessions: {}, sessionListRowsByServerId: { 'home-b': rows } });
            const addresses = sessions.map(session => ({ serverId: 'home-b', sessionId: session.id }));
            const hook = await renderHook(() => useSessionDisplayTitles(addresses));
            expect(hook.getCurrent()).toEqual(sessions.map(session => getSessionName(rows[session.id]!, 'home-b')));
            expect(hook.getCurrent()).toEqual(['Review release', 'Shared review', 'Untitled session']);
            // A same-id record on the focused Home must never name the captured Home's row.
            await act(async () => { storage.setState({ sessions: { opened: createSessionFixture({ id: 'opened', serverId: 'home-a',
                metadata: { name: 'Wrong Home', host: 'other', path: '/other' } }) } }); });
            expect(hook.getCurrent()[0]).toBe('Review release');
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('keeps batched readable titles stable across lifecycle changes and withdraws a cached title when content locks', async () => {
        const previousState = storage.getState();
        try {
            const session = createSessionFixture({ id: 'private-bot', serverId: 'home-a',
                metadata: { name: 'Payments coordinator', host: 'localhost', path: '/payments' } });
            storage.setState({ sessions: { [session.id]: session } });
            const addresses = [{ serverId: 'home-a', sessionId: session.id }];
            const hook = await renderHook(() => useSessionDisplayNameProjections(addresses, readableSessionDisplayTitle));
            expect(hook.getCurrent()).toEqual(['Payments coordinator']);
            const before = hook.getCurrent();
            await act(async () => { storage.setState({ sessions: { [session.id]: { ...session, thinking: true, updatedAt: 2 } } }); });
            expect(hook.getCurrent()).toBe(before);
            await act(async () => { storage.setState({ sessions: { [session.id]: { ...session,
                encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable' } } }); });
            expect(hook.getCurrent()).toEqual([null]);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
    it('does not re-render when turn-lifecycle Session fields change', async () => {
        const previousState = storage.getState();
        try {
            const metadata: Session['metadata'] = { flavor: 'codex', host: 'localhost', path: '/tmp/project' };
            const ownerMetadataView: Session['ownerMetadataView'] = { ...metadata, name: 'Initial title' };
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    's-1': ({
                        id: 's-1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata,
                        metadataLayoutVersion: 1,
                        ownerMetadataView,
                        metadataVersion: 1,
                        agentState: null,
                        agentStateVersion: 1,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 1,
                    } satisfies Session),
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionDisplayNameSource('s-1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            const initialSource = hook.getCurrent();

            expect(initialSource).toMatchObject({
                id: 's-1',
                metadata,
                metadataLayoutVersion: 1,
                ownerMetadataView,
            });

            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                thinking: true,
                                updatedAt: 2,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toBe(initialSource);
            expect(renderCount).toBe(initialRenderCount);

            const updatedOwnerMetadataView: Session['ownerMetadataView'] = { ...metadata, name: 'Updated title' };
            await act(async () => {
                storage.setState((state) => {
                    const session = state.sessions['s-1'];
                    if (!session) return state;
                    return {
                        ...state,
                        sessions: {
                            ...state.sessions,
                            's-1': {
                                ...session,
                                ownerMetadataView: updatedOwnerMetadataView,
                            },
                        },
                    };
                });
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent()).toMatchObject({ ownerMetadataView: updatedOwnerMetadataView });
            expect(renderCount).toBe(initialRenderCount + 1);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
