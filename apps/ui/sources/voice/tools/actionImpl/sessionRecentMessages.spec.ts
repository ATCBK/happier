import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture, createSessionListRenderableSessionFixture, createSessionMessagesFixture, createSessionViewerFixture } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRetainedVoiceAgentRpcBoundary } from '@/dev/testkit/harness/voiceAgentRpcBoundary';

import type { Message } from "@happier-dev/session-core/messages";
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import type { SessionMessages } from '@/sync/store/domains/messages';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
const { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } = await import('@/dev/testkit/harness/standaloneVoicePolicyHarness');
await prepareStandaloneVoicePolicyHarness();

function isCanonicalSessionTranscriptActionOutput(value: unknown): boolean {
    const spec = getActionSpec('session.transcript.get');
    if (!spec?.outputSchema) throw new Error('session.transcript.get output schema is unavailable');
    return spec.outputSchema.safeParse(value).success;
}

function createTestSessionMessages(messages: ReadonlyArray<Message>): SessionMessages {
    const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    return createSessionMessagesFixture({
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById,
        messagesMap: messagesById,
        isLoaded: true,
    });
}

describe('getSessionRecentMessagesForVoiceTool', () => {
    beforeEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: {
                ...settingsDefaults,
                voice: {
                    ...settingsDefaults.voice,
                    privacy: {
                        ...settingsDefaults.voice.privacy,
                        shareRecentMessages: true,
                    },
                },
            },
            // A retained transcript is only readable through a stored Session row, which
            // supplies its Home provenance; here that Home is the loaded one.
            sessions: { s1: createSessionFixture({
                id: 's1',
                serverId: getActiveServerSnapshot().serverId,
                viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'important', includeInVoice: true } }),
            }) },
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'hello', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'assistant reply', createdAt: 2 },
                ]),
            },
        }));
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: 'server-a', sessionId: 's1' },
        ]);
    });

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
        }));
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    });

    it('returns recent messages from normalized transcript state', async () => {
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({
                sessionId: 's1',                limit: 10,
            }),
        ).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            messages: [
                {
                    id: 'm1',
                    role: 'user',
                    text: 'hello',
                    createdAt: 1,
                },
                {
                    id: 'm2',
                    role: 'assistant',
                    text: 'assistant reply',
                    createdAt: 2,
                },
            ],
            nextCursor: '1:m1',
        });
    });

    it('fails closed for tool args and file paths when privacy fields are omitted', async () => {
        storage.setState((current) => ({
            ...current,
            settings: {
                ...current.settings,
                voice: {
                    ...current.settings.voice,
                    privacy: {
                        ...current.settings.voice.privacy,
                        shareRecentMessages: true,
                        shareToolNames: true,
                    },
                },
            },
            sessionMessages: {
                s1: createTestSessionMessages([
                    {
                        id: 'm_tool',
                        kind: 'tool-call',
                        localId: null,
                        createdAt: 3,
                        children: [],
                        tool: {
                            name: 'read',
                            description: 'Read a file',
                            state: 'completed',
                            input: { path: '/Users/alice/SecretRepo/README.md' },
                            createdAt: 3,
                            startedAt: 3,
                            completedAt: 4,
                        },
                    },
                ]),
            },
        }));

        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({
                sessionId: 's1',                limit: 10,
            }),
        ).resolves.toEqual({
            ok: true,
            sessionId: 's1',
            messages: [
                {
                    id: 'm_tool',
                    role: 'tool',
                    text: 'Tool: read - Read a file',
                    createdAt: 3,
                },
            ],
            nextCursor: '3:m_tool',
        });
    });

    it('uses a stable cursor that does not skip same-timestamp siblings', async () => {
        storage.setState((current) => ({
            ...current,
            sessionMessages: {
                s1: createTestSessionMessages([
                    { id: 'm1', kind: 'user-text', localId: null, text: 'oldest', createdAt: 1 },
                    { id: 'm2', kind: 'agent-text', localId: null, text: 'same-ts-a', createdAt: 2 },
                    { id: 'm3', kind: 'agent-text', localId: null, text: 'same-ts-b', createdAt: 2 },
                    { id: 'm4', kind: 'agent-text', localId: null, text: 'newest', createdAt: 3 },
                ]),
            },
        }));

        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        const firstPage = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',            limit: 2,
        });

        expect(firstPage).toMatchObject({
            ok: true,
            messages: [
                { id: 'm3', text: 'same-ts-b', createdAt: 2 },
                { id: 'm4', text: 'newest', createdAt: 3 },
            ],
        });

        const secondPage = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',            limit: 2,
            cursor: (firstPage as { nextCursor: string | null }).nextCursor,
        });

        expect(secondPage).toMatchObject({
            ok: true,
            messages: [
                { id: 'm1', text: 'oldest', createdAt: 1 },
                { id: 'm2', text: 'same-ts-a', createdAt: 2 },
            ],
        });
    });

    it('does not promote loaded snippets into an authoritative transcript without Account scope', async () => {
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({
            sessionId: 's1',            limit: 10,
        });

        expect(result).toEqual({ ok: false, errorCode: 'admission_unavailable', errorMessage: 'admission_unavailable' });
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });

    it('fails closed when the local projection is asked for an external shareable transcript', async () => {
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({
            sessionId: 's1',            projection: 'externalShareableV1',
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'external_shareable_projection_unavailable',
            errorMessage: 'external_shareable_projection_unavailable',
        });
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });
});

describe('voice recent-message and transcript projection Home identity', () => {
    const FOCUSED_HOME_ROWS: ReadonlyArray<Message> = [
        { id: 'm1', kind: 'user-text', localId: null, text: 'focused home secret', createdAt: 1 },
        { id: 'm2', kind: 'agent-text', localId: null, text: 'focused home reply', createdAt: 2 },
    ];

    function seedFocusedHomeTranscript(
        otherSessionsSnippetsMode: 'auto' | 'never' | 'on_demand_only',
    ): string {
        const activeServerId = getActiveServerSnapshot().serverId;
        storage.setState((current) => ({
            ...current,
            settings: {
                ...settingsDefaults,
                voice: {
                    ...settingsDefaults.voice,
                    privacy: {
                        ...settingsDefaults.voice.privacy,
                        shareRecentMessages: true,
                    },
                    ui: {
                        ...settingsDefaults.voice.ui,
                        updates: {
                            ...settingsDefaults.voice.ui.updates,
                            otherSessionsSnippetsMode,
                        },
                    },
                },
            },
            // The focused Home owns both the retained transcript and the live Voice context.
            sessions: { s1: createSessionFixture({ id: 's1', serverId: activeServerId }) },
            sessionMessages: { s1: createTestSessionMessages(FOCUSED_HOME_ROWS) },
        }));
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        return activeServerId;
    }

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
        }));
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    });

    it('classifies an Action bound to another Home as a non-active target instead of matching the focused Home', async () => {
        seedFocusedHomeTranscript('never');
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('never returns the focused Home transcript for a same-named Session on the requested Home', async () => {
        const activeServerId = seedFocusedHomeTranscript('auto');
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 }),
        ).resolves.toEqual({ ok: true, sessionId: 's1', messages: [], nextCursor: null });

        const focused = await getSessionRecentMessagesForVoiceTool({
            sessionId: 's1',
            serverId: activeServerId,
            limit: 10,
        });
        expect(focused).toMatchObject({
            ok: true,
            messages: [
                { id: 'm1', role: 'user', text: 'focused home secret' },
                { id: 'm2', role: 'assistant', text: 'focused home reply' },
            ],
        });
    });

    it('cannot substitute the focused Home transcript when the requested Home has no captured Account authority', async () => {
        seedFocusedHomeTranscript('auto');
        const { getSessionTranscriptForVoiceTool } = await import('./sessionRecentMessages');

        const result = await getSessionTranscriptForVoiceTool({ sessionId: 's1', serverId: 'home-b', limit: 10 });

        expect(result).toEqual({ ok: false, errorCode: 'admission_unavailable', errorMessage: 'admission_unavailable' });
        expect(JSON.stringify(result)).not.toContain('focused home secret');
        expect(isCanonicalSessionTranscriptActionOutput(result)).toBe(true);
    });

    it('refuses an unqualified invocation when the session id exists on more than one known Home', async () => {
        seedFocusedHomeTranscript('auto');
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                'home-b': { s1: createSessionListRenderableSessionFixture({ id: 's1', updatedAt: 7 }) },
            },
            ordinarySessionListMembershipByServerId: {
                'home-b': ['s1'],
            },
        }));
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'session_ambiguous',
            errorMessage: 'session_ambiguous',
        });
    });

    it('refuses an unqualified invocation for a session id local state does not know', async () => {
        // The retained transcript survives, but nothing proves which Home owns it, so the
        // focused Home must not be substituted for the Home the Action host failed to bind.
        seedFocusedHomeTranscript('auto');
        storage.setState((current) => ({ ...current, sessions: {} }));
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'session_not_found',
            errorMessage: 'session_not_found',
        });
    });
});

describe('voice recent-message live-context qualification', () => {
    const ROWS: ReadonlyArray<Message> = [
        { id: 'm1', kind: 'user-text', localId: null, text: 'bound session text', createdAt: 1 },
    ];

    function seedBoundHomeTranscript(): string {
        const activeServerId = getActiveServerSnapshot().serverId;
        storage.setState((current) => ({
            ...current,
            settings: {
                ...settingsDefaults,
                voice: {
                    ...settingsDefaults.voice,
                    privacy: { ...settingsDefaults.voice.privacy, shareRecentMessages: true },
                    ui: {
                        ...settingsDefaults.voice.ui,
                        updates: { ...settingsDefaults.voice.ui.updates, otherSessionsSnippetsMode: 'never' },
                    },
                },
            },
            sessions: { s1: createSessionFixture({ id: 's1', serverId: activeServerId }) },
            sessionMessages: { s1: createTestSessionMessages(ROWS) },
            sessionListRowsByServerId: {},
        }));
        // Attempt-local context starts empty and cannot substitute for Account Follow consent.
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        return activeServerId;
    }

    afterEach(() => {
        storage.setState((current) => ({
            ...current,
            settings: settingsDefaults,
            sessions: {},
            sessionMessages: {},
        }));
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    });

    it('uses the synchronized exact-Home Include in Voice projection as disclosure authority', async () => {
        const activeServerId = seedBoundHomeTranscript();
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                ...current.sessionListRowsByServerId,
                [activeServerId]: {
                    s1: createSessionListRenderableSessionFixture({
                        id: 's1',
                        viewer: createSessionViewerFixture({
                            follow: { follows: true, notificationLevel: 'important', includeInVoice: true },
                        }),
                    }),
                },
            },
        }));
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toMatchObject({
            ok: true,
            messages: [{ id: 'm1', role: 'user', text: 'bound session text' }],
        });
    });

    it('does not treat an attempt-local live-context address as disclosure consent', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('reflects an external Follow projection change without consulting stale attempt-local state', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([
            { serverId: activeServerId, sessionId: 's1' },
        ]);
        storage.setState((current) => ({
            ...current,
            sessionListRowsByServerId: {
                ...current.sessionListRowsByServerId,
                [activeServerId]: {
                    s1: createSessionListRenderableSessionFixture({
                        id: 's1',
                        viewer: createSessionViewerFixture({
                            follow: { follows: true, notificationLevel: 'important', includeInVoice: false },
                        }),
                    }),
                },
            },
        }));
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });

    it('still refuses a Session that is neither bound nor in the live context', async () => {
        const daemon = await createRetainedVoiceAgentRpcBoundary();
        const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off',
            existingSession: { id: 'voice-transcript-hidden', active: true, metadata: {
                path: '/voice', host: 'voice.test', flavor: 'claude',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
            } },
            sessions: ['s1', 'other-session'].map(id => createSessionFixture({ id, active: true, activeAt: Date.now(),
                metadata: { path: '/project', host: 'voice.test', flavor: 'claude',
                    agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
                },
            })),
            dispatch: daemon.dispatch,
        });
        const activeServerId = getActiveServerSnapshot().serverId;
        let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');
        try {
            activation = await fixture.activateLocalAgent({ serverId: activeServerId, sessionId: 'other-session' });
            const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
            const { resolveActiveLocalVoiceAgentBinding } = await import('@/voice/context/resolveActiveLocalVoiceAgentBinding');
            expect(activation.controller.isAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
            expect(resolveActiveLocalVoiceAgentBinding()?.binding?.targetSessionAddress)
                .toEqual({ serverId: activeServerId, sessionId: 'other-session' });
            storage.setState(current => ({
                settings: { ...current.settings, voice: { ...current.settings.voice,
                    privacy: { ...current.settings.voice.privacy, shareRecentMessages: true },
                    ui: { ...current.settings.voice.ui, updates: { ...current.settings.voice.ui.updates, otherSessionsSnippetsMode: 'never' } },
                } },
                sessionMessages: { s1: createTestSessionMessages(ROWS) },
            }));
            useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
            await expect(getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 })).resolves.toEqual({
                ok: false, errorCode: 'other_sessions_snippets_disabled', errorMessage: 'other_sessions_snippets_disabled',
            });
        } finally {
            await activation?.dispose();
            await fixture.dispose();
        }
    });

    it('does not treat the primary Action target as live-context disclosure consent', async () => {
        const activeServerId = seedBoundHomeTranscript();
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress({ serverId: activeServerId, sessionId: 's1' });
        const { getSessionRecentMessagesForVoiceTool } = await import('./sessionRecentMessages');

        await expect(
            getSessionRecentMessagesForVoiceTool({ sessionId: 's1', serverId: activeServerId, limit: 10 }),
        ).resolves.toEqual({
            ok: false,
            errorCode: 'other_sessions_snippets_disabled',
            errorMessage: 'other_sessions_snippets_disabled',
        });
    });
});
