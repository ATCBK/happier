import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { createTestSessionTranscriptSource, renderScreen, standardCleanup, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { QuietWorkflowTurn } from './QuietWorkflowTurn';
import { TurnView } from './TurnView';
import { TranscriptRowLayoutMutationProvider } from '../measurement/TranscriptRowLayoutMutationContext';

// Enriched Markdown's browser-only WASM adapter is outside this presentation's process boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
afterEach(standardCleanup);
const userMessage: Message = { kind: 'user-text', id: 'habit', localId: null, createdAt: 1, text: 'Summarize the release',
    meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step', stepOrdinal: '1' } } };
const reply: Message = { kind: 'agent-text', id: 'reply', localId: null, createdAt: 2, text: 'Nothing to report\nFull details stay available.' };

describe('quiet workflow turn disclosure', () => {
    it('starts folded, preserves the first reply line and discloses the full turn with accessible local controls', async () => {
        const mutations = vi.fn();
        const source = createTestSessionTranscriptSource({ messages: [userMessage, reply] });
        const screen = await renderScreen(wrapWithSessionTranscriptSource(
            <TranscriptRowLayoutMutationProvider value={mutations}>
                <QuietWorkflowTurn turnId="turn:habit" userMessage={userMessage} messages={[userMessage, reply]} reducedMotion>
                    <View testID="full-habit-turn">
                        <TurnView turn={{ id: 'turn:habit', userMessageId: 'habit', content: [{ kind: 'message', messageId: 'reply' }] }}
                            sessionId={source.sessionId} metadata={null} activeThinkingMessageId={null}
                            getMessageById={(id) => id === userMessage.id ? userMessage : id === reply.id ? reply : null}
                            hideUserProvenanceAttribution expandedToolCallsAnchorMessageIds={new Set()}
                            setToolCallsGroupExpanded={() => {}} interaction={{ canSendMessages: false, canApprovePermissions: false }} />
                    </View>
                </QuietWorkflowTurn>
            </TranscriptRowLayoutMutationProvider>, source));
        const toggleId = 'quiet-workflow-turn-toggle:turn:habit';
        expect(screen.tree.findByTestId(toggleId)?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(screen.tree.findByTestId(toggleId)?.props.accessibilityLabel).toContain('Nothing to report');
        expect(screen.tree.findAllHostsByTestId('full-habit-turn')).toHaveLength(0);
        await screen.tree.pressByTestIdAsync(toggleId);
        expect(screen.tree.findByTestId(toggleId)?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.tree.findAllHostsByTestId('full-habit-turn')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('transcript-message-habit')).toHaveLength(1);
        expect(screen.tree.findAllHostsByTestId('transcript-message-reply')).toHaveLength(1);
        expect(mutations).toHaveBeenLastCalledWith({ reason: 'expand', sourceId: 'turn:habit' });
        await screen.tree.pressByTestIdAsync(toggleId);
        expect(screen.tree.findAllHostsByTestId('full-habit-turn')).toHaveLength(0);
        expect(mutations).toHaveBeenLastCalledWith({ reason: 'collapse', sourceId: 'turn:habit' });
    });
});
