import * as React from 'react';
import { View, ScrollView, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { QuietWorkflowTurn } from '@/components/sessions/transcript/turns/QuietWorkflowTurn';
import { TurnView } from '@/components/sessions/transcript/turns/TurnView';
import { buildTranscriptTurnsCached } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';

/** Static lab Q/Qp illustration through the actual transcript owners; no Account reads or writes. */
const messages: Message[] = [
    { kind: 'agent-text', id: 'release-status', localId: null, createdAt: Date.UTC(2026, 9, 10, 15),
        text: '0.3.1 is tagged and the draft release is published. I’ll keep an eye on the next one.' },
    { kind: 'user-text', id: 'memory-upkeep', localId: null, createdAt: Date.UTC(2026, 9, 11, 3),
        text: 'Review the release captain’s memory. Keep current facts and retire superseded facts.',
        meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'memory-upkeep-run', invocationRecordId: 'upkeep', stepOrdinal: '1' } } },
    { kind: 'agent-text', id: 'memory-upkeep-reply', localId: null, createdAt: Date.UTC(2026, 9, 11, 3, 1),
        text: 'Updated 4 facts\nRetired two superseded release dates and kept the current review owners.' },
    { kind: 'user-text', id: 'daily-summary', localId: null, createdAt: Date.UTC(2026, 9, 12, 9),
        text: 'Summarize what changed since yesterday for the next release. Reply with nothing if nothing needs Leeroy.',
        meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily-summary-run', invocationRecordId: 'summary', stepOrdinal: '1' } } },
    { kind: 'agent-text', id: 'daily-summary-reply', localId: null, createdAt: Date.UTC(2026, 9, 12, 9, 1),
        text: 'Nothing to report\nAll overnight checks are green. No release decision is waiting on you.' },
    { kind: 'user-text', id: 'reported-summary', localId: null, createdAt: Date.UTC(2026, 9, 13, 9),
        text: 'Summarize what changed since yesterday for the next release. Reply with nothing if nothing needs Leeroy.',
        meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'reported-summary-run', invocationRecordId: 'summary', stepOrdinal: '1' } } },
    { kind: 'agent-text', id: 'reported-summary-reply', localId: null, createdAt: Date.UTC(2026, 9, 13, 9, 1),
        text: 'Two things need you before 0.3.2:\n\n- **#2490** is waiting on Ana’s review of the sync changes. The freeze starts Thursday at 18:00.\n- Last night’s iOS snapshot tests failed on the share sheet. Mac tester is on it; nothing to do yet.' },
];
const byId = Object.fromEntries(messages.map((message) => [message.id, message]));
const getMessageById = (id: string) => byId[id] ?? null;
const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst: messages.map((message) => message.id), messagesById: byId,
    groupToolCalls: false, toolCallsGroupStrategy: 'consecutive_tools' });
// Fixture observations model the producer's outcome. The static source never reads private Run facts.
const notificationConditions = new Map<string, 'suppressed' | 'matched'>([
    ['memory-upkeep', 'suppressed'], ['daily-summary', 'suppressed'], ['reported-summary', 'matched'],
]);
const noExpansion = () => {};
const noSuggestions = async () => [];
const noExpandedTools = new Set<string>();

export default function QuietHabitTranscriptDemo() {
    const source = useDemoMessages(messages);
    const interaction = source.useInteraction();
    const { height } = useWindowDimensions();
    return <SessionTranscriptSourceProvider source={source}>
        <SurfaceCard style={[styles.frame, { minHeight: height - 120 }]}>
            <PageHeader title="Release captain" />
            <ScrollView style={styles.transcript} contentContainerStyle={styles.content}>
                {turns.map((turn) => {
                    const userMessage = turn.userMessageId ? getMessageById(turn.userMessageId) : null;
                    const quiet = !!userMessage && notificationConditions.get(userMessage.id) === 'suppressed';
                    const body = <TurnView turn={turn} sessionId={source.sessionId} metadata={null} activeThinkingMessageId={null}
                        getMessageById={getMessageById} interaction={interaction} expandedToolCallsAnchorMessageIds={noExpandedTools}
                        setToolCallsGroupExpanded={noExpansion} hideUserProvenanceAttribution={quiet} />;
                    if (quiet && userMessage) return <QuietWorkflowTurn key={turn.id} turnId={turn.id} userMessage={userMessage}
                        messages={turn.content.flatMap((content) => content.kind === 'message' && byId[content.messageId] ? [byId[content.messageId]!] : [])}>
                        {body}
                    </QuietWorkflowTurn>;
                    return <View key={turn.id}>{body}</View>;
                })}
            </ScrollView>
            <View style={styles.composer}><AgentInput value="" placeholder="Message Release captain…" autocompleteKinds={[]}
                autocompleteSuggestions={noSuggestions} engineControls="none" voiceAffordance="none" messageHistory="none" /></View>
        </SurfaceCard>
    </SessionTranscriptSourceProvider>;
}

const styles = StyleSheet.create((theme) => ({
    frame: { width: '100%', backgroundColor: theme.colors.surface.base },
    transcript: { flex: 1 },
    content: { paddingVertical: theme.margins.lg, gap: theme.margins.sm },
    composer: { padding: theme.margins.lg },
}));
