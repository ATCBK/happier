import * as React from 'react';
import { View } from 'react-native';

import {
    DISCUSSION_COMPOSER_SUGGESTION_KINDS,
    type ComposerAccountMentionSource,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { AgentInput } from '@/components/sessions/agentInput';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import {
    structuredInputMentionSurvivesText,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { listSessionDiscussionMentionCandidates } from '@/sync/api/session/sessionDiscussionActions';
import {
    reportSessionDiscussionTypingEdit,
    stopSessionDiscussionTyping,
} from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { t } from '@/text';

import {
    buildSessionDiscussionContent,
    buildSessionDiscussionContentFromPendingText,
    discussionComposerMentionsFromSpans,
    discussionMentionSpansFromComposerMentions,
    parseDiscussionMentionSpans,
    type DiscussionMentionSpan,
} from './discussionComposerDocument';

export type SessionDiscussionComposerValue = Readonly<{
    text: string;
    mentions: readonly DiscussionMentionSpan[];
}>;

type LatestComposerDocument = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>;

/**
 * A human discussion's composer: the one composer (`AgentInput`) with the discussion adapter
 * behind it (INT §6 I4 "One pane"). The adapter owns what is human here — who can be mentioned
 * (the `accountMention` kind, fed by this Session's readers), the discussion's typing presence, and
 * an empty draft that stays editable — and serializes the document to the discussion's own wire
 * shape. Nothing an agent composer carries is offered: no engine, voice, chips or prompt history.
 */
export function SessionDiscussionComposer(props: Readonly<{
    scope: ServerAccountScope;
    address: SessionAddress;
    discussionId?: string;
    availability: SessionCollaborationAvailability;
    value: SessionDiscussionComposerValue;
    onChange: (value: SessionDiscussionComposerValue) => void;
    disabled: boolean;
    onSend: (content: ReturnType<typeof buildSessionDiscussionContent>) => void;
}>): React.ReactElement {
    const { scope, address, availability, disabled } = props;
    const composerMentions = React.useMemo(
        () => discussionComposerMentionsFromSpans(props.value.text, props.value.mentions),
        [props.value.mentions, props.value.text],
    );

    // The composer reports text and mentions in separate callbacks, in either order. The draft
    // admits a mention only against the text it covers, so both are written together from the
    // latest pair; an external draft replacement (another device, a clear after send) resets it.
    const latestRef = React.useRef<LatestComposerDocument>({ text: props.value.text, mentions: composerMentions });
    const observedValueRef = React.useRef(props.value);
    if (observedValueRef.current !== props.value) {
        observedValueRef.current = props.value;
        if (props.value.text !== latestRef.current.text) {
            latestRef.current = { text: props.value.text, mentions: composerMentions };
        }
    }
    const onChangeRef = React.useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const write = React.useCallback((next: LatestComposerDocument) => {
        latestRef.current = next;
        onChangeRef.current({
            text: next.text,
            mentions: discussionMentionSpansFromComposerMentions(
                next.mentions.filter((mention) => structuredInputMentionSurvivesText(next.text, mention)),
            ),
        });
    }, []);

    const presenceTarget = React.useMemo(() => props.discussionId
        ? { serverId: address.serverId, sessionId: address.sessionId, discussionId: props.discussionId }
        : null, [address.serverId, address.sessionId, props.discussionId]);
    React.useEffect(() => {
        if (disabled && presenceTarget) stopSessionDiscussionTyping(presenceTarget);
    }, [disabled, presenceTarget]);
    React.useEffect(() => () => {
        if (presenceTarget) stopSessionDiscussionTyping(presenceTarget);
    }, [presenceTarget]);

    const onChangeText = React.useCallback((text: string) => {
        if (presenceTarget) reportSessionDiscussionTypingEdit(presenceTarget, text.trim().length > 0);
        write({ text, mentions: latestRef.current.mentions });
    }, [presenceTarget, write]);

    const onMentionsChange = React.useCallback((mentions: readonly ComposerStructuredInputMention[]) => {
        const text = latestRef.current.text;
        if (mentions.every((mention) => structuredInputMentionSurvivesText(text, mention))) {
            write({ text, mentions });
            return;
        }
        // Reported ahead of the text it covers: the text change that follows writes both.
        latestRef.current = { text, mentions };
    }, [write]);

    const onFocusChange = React.useCallback((focused: boolean) => {
        if (!focused && presenceTarget) stopSessionDiscussionTyping(presenceTarget);
    }, [presenceTarget]);

    // Retry is a new source, hence a new handler: the open picker asks again for the same token
    // (useActiveSuggestions re-runs its query when the handler changes).
    const [searchRevision, setSearchRevision] = React.useState(0);
    const accountMentions = React.useMemo<ComposerAccountMentionSource>(() => ({
        search: async ({ query, limit, signal }) => {
            if (availability !== 'available') return { candidates: [], hasMore: false };
            const page = await listSessionDiscussionMentionCandidates({
                scope,
                session: address,
                availability,
                ...(query ? { query } : {}),
                limit,
                ...(signal ? { signal } : {}),
            });
            return { candidates: page.candidates, hasMore: page.nextCursor !== null };
        },
        retry: () => setSearchRevision((revision) => revision + 1),
        // `searchRevision` is read by nothing inside: it is what makes a retried source a new one.
    }), [address, availability, scope, searchRevision]);
    const suggestAccounts = React.useCallback((query: string, signal: AbortSignal) => getSuggestions(null, query, {
        kinds: DISCUSSION_COMPOSER_SUGGESTION_KINDS,
        accountMentions,
        signal,
    }), [accountMentions]);

    const onSendProp = props.onSend;
    const send = React.useCallback((options?: AgentInputSendOptions) => {
        const latest = latestRef.current;
        const text = options?.inputTextOverride ?? latest.text;
        if (disabled || text.trim().length === 0) return;
        if (presenceTarget) stopSessionDiscussionTyping(presenceTarget);
        onSendProp(buildSessionDiscussionContentFromPendingText({
            previousText: latest.text,
            pendingText: text,
            mentions: parseDiscussionMentionSpans(discussionMentionSpansFromComposerMentions(latest.mentions), latest.text),
        }));
    }, [disabled, onSendProp, presenceTarget]);

    const placeholder = t('session.collaboration.discussion.messagePlaceholder');
    return (
        <View testID="session-discussion-composer-root">
            <AgentInput
                value={props.value.text}
                placeholder={placeholder}
                inputAccessibilityLabel={placeholder}
                submitAccessibilityLabel={t('common.send')}
                onChangeText={onChangeText}
                structuredInputMentions={composerMentions}
                onStructuredInputMentionsChange={onMentionsChange}
                onComposerFocusChange={onFocusChange}
                onSend={send}
                disabled={disabled}
                autocompleteKinds={DISCUSSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={suggestAccounts}
                engineControls="none"
                voiceAffordance="none"
                messageHistory="none"
            />
        </View>
    );
}
