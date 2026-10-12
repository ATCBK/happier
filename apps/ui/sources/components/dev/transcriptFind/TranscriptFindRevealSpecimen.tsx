import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ChatList } from '@/components/sessions/transcript/ChatList';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';
import { createTranscriptFindRevealMessages, TRANSCRIPT_FIND_REVEAL_OLDER } from './transcriptFindRevealFixture';

const SESSION_ID = 'dev-transcript-find-reveal';

/**
 * The real session transcript (ChatList: Find model, reveal, jump host, web driver and the
 * Legend renderer) over a local read-only history, for the chat-Find reveal browser
 * regression. History timing is the only boundary it scripts: `hydrateAfterMs` publishes the
 * first page late (query before hydration) and `withOlderHistory` keeps an older page behind
 * Search older for `olderDelayMs`. Each published page is also written to the app's session
 * message store, where the jump host resolves message identity for app sessions.
 */
function publishToSessionStore(messages: readonly Message[], isLoaded: boolean) {
    getStorage().setState((state) => ({ sessionMessages: { ...state.sessionMessages, [SESSION_ID]: createSessionMessagesFixture({
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
        messageIdsOldestFirst: messages.map((message) => message.id),
        isLoaded,
    }) } }));
}

export function TranscriptFindRevealSpecimen(props: Readonly<{
    hydrateAfterMs: number;
    withOlderHistory: boolean;
    olderDelayMs: number;
}>) {
    const firstSeq = props.withOlderHistory ? TRANSCRIPT_FIND_REVEAL_OLDER.length + 1 : 1;
    const [loaded] = React.useState(() => createTranscriptFindRevealMessages(firstSeq));
    const [session] = React.useState(() => createSessionFixture({ id: SESSION_ID, seq: firstSeq + loaded.length }));
    const [source] = React.useState(() => {
        const snapshot = (messages: typeof loaded, hasOlder: boolean, isLoaded: boolean) => ({
            messages, reducerState: null, metadata: session.metadata, agentState: null,
            historyState: { isLoaded, hasOlder, isLoadingOlder: false },
        });
        const created = createReadOnlySessionTranscriptSource({
            sessionId: SESSION_ID,
            // A late hydration starts from the tail row alone, as a cold session paints its newest row first.
            ...snapshot(props.hydrateAfterMs > 0 ? loaded.slice(-1) : loaded, props.withOlderHistory, props.hydrateAfterMs <= 0),
            loadOlder: props.withOlderHistory ? async () => {
                await new Promise((resolve) => setTimeout(resolve, props.olderDelayMs));
                publishToSessionStore([...TRANSCRIPT_FIND_REVEAL_OLDER, ...loaded], true);
                created.update(snapshot([...TRANSCRIPT_FIND_REVEAL_OLDER, ...loaded], false, true));
                return { loaded: TRANSCRIPT_FIND_REVEAL_OLDER.length, hasMore: false, status: 'loaded' as const };
            } : undefined,
        });
        return created;
    });
    React.useLayoutEffect(() => {
        publishToSessionStore(props.hydrateAfterMs > 0 ? loaded.slice(-1) : loaded, props.hydrateAfterMs <= 0);
        return () => getStorage().setState((state) => {
            const { [SESSION_ID]: _removed, ...sessionMessages } = state.sessionMessages;
            return { sessionMessages };
        });
    }, [loaded, props.hydrateAfterMs]);
    React.useEffect(() => {
        if (props.hydrateAfterMs <= 0) return;
        const timer = setTimeout(() => {
            publishToSessionStore(loaded, true);
            source.update({
                messages: loaded, reducerState: null, metadata: session.metadata, agentState: null,
                historyState: { isLoaded: true, hasOlder: props.withOlderHistory, isLoadingOlder: false },
            });
        }, props.hydrateAfterMs);
        return () => clearTimeout(timer);
    }, [loaded, props.hydrateAfterMs, props.withOlderHistory, session.metadata, source]);
    return (
        <View style={styles.container} testID="dev-transcript-find-reveal">
            <PluginSurfaceFocusEligibilityProvider active>
                <SessionTranscriptSourceProvider source={source}>
                    <ChatList session={session} sessionSurfaceKey={JSON.stringify(['dev', SESSION_ID])} />
                </SessionTranscriptSourceProvider>
            </PluginSurfaceFocusEligibilityProvider>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
}));
