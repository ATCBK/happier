import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    DISCUSSION_COMPOSER_SUGGESTION_KINDS,
    resolveComposerSuggestionScope,
    resolveComposerSuggestionKind,
    type ComposerAccountMentionSource,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { matchesComposerSuggestionQuery, type ComposerSuggestionCatalogs } from '@/components/autocomplete/composerSuggestionCatalogs';
import type { TranscriptAccountActor } from '@happier-dev/session-core/messages';
import type { DiscussionInitialParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import type { SessionResponsibilityCandidateV1 } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import { AgentInput } from '@/components/sessions/agentInput';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput/agentInputSendOptions';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
    structuredInputMentionSurvivesText,
    reconcileStructuredInputMentionsWithText,
    type ComposerStructuredInputMention,
} from '@/components/sessions/agentInput/structuredInputMentions';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { reportDiscussionTypingEdit, stopDiscussionTyping } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { t } from '@/text';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { DiscussionComposerMount } from './DiscussionComposerMount';
import { DiscussionComposerPluginContributions } from './DiscussionComposerPluginContributions';
import { createMentionActionChip } from '@/components/sessions/agentInput/definitions/createMentionActionChip';
import { createRecipientMultiSelectActionChip } from '@/components/sessions/agentInput/definitions/createRecipientActionChip';
import type { RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { readComposerSessionSuggestionDisplay } from '@/sync/domains/input/suggestionSession';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveExecutableModelParticipantDisplay } from '@/components/sessions/authoring/useExecutableParticipantLabel';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { parseComposerSuggestionQuery } from '@/components/autocomplete/composerSuggestionGrammar';

import {
    buildDiscussionContent,
    buildDiscussionModelSlotMentionPayload,
    readDiscussionMentionParticipant,
} from './discussionComposerDocument';

import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

export type DiscussionComposerValue = Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>;

/**
 * A human discussion's composer: the one composer (`AgentInput`) with the discussion adapter
 * behind it (INT §6 I4 "One pane"). The adapter owns what is human here — who can be mentioned
 * (people, executable Sessions and inert reserved-model slots from this Discussion's roster), and
 * an empty draft that stays editable — and serializes the document to the discussion's own wire
 * shape, resolving slots to real Session mentions only on Send. Nothing an agent composer carries
 * is offered (no engine, conversational Voice or prompt history);
 * the person gets `@` as a control and dictation, which only writes words into the field.
 */
// The composer brings its own side gutter and half of it below; a pane foot adds the other half, so the
// card sits as far from the pane's bottom edge as from its sides.
const styles = StyleSheet.create((theme) => ({
    root: { paddingBottom: theme.space.s8 },
    hint: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 1, marginRight: theme.space.s4 },
}));

export function DiscussionComposer(props: Readonly<{
    scope: ServerAccountScope;
    accountLifetime: ServerAccountScopeLifetime;
    address: DiscussionHomeAddress;
    discussionId?: string;
    availability: SessionCollaborationAvailability;
    value: DiscussionComposerValue;
    onChange: (value: DiscussionComposerValue) => void;
    disabled: boolean;
    onSend: (content: ReturnType<typeof buildDiscussionContent>) => void;
    /** Send-only resolution of inert model slots; never called by typing or selection. */
    prepareParticipantMentions?: (document: DiscussionComposerValue, isCurrent: () => boolean) => Promise<ReturnType<typeof buildDiscussionContent> | null>;
    /** The page's own composer controls after `@` (a running Discussion's Run…). */
    extraActionChips?: readonly AgentInputExtraActionChip[];
    /** Who this draft addresses by default (C3 DISC-18): the session Send to chip, leading the rail. */
    recipients?: RecipientMultiSelectModel<unknown>;
    /**
     * A New Discussion's chosen invitees: before a roster exists they are who `@` can address in the
     * first message (C3 §6.1), with the names the page already resolved for them.
     */
    invited?: Readonly<{ participants: readonly DiscussionInitialParticipantV1[]; accounts: ReadonlyMap<string, TranscriptAccountActor> }>;
}>): React.ReactElement {
    const { scope, availability, disabled, accountLifetime } = props;
    const currentContext = React.useRef({ accountLifetime, discussionId: props.discussionId, disabled, availability });
    currentContext.current = { accountLifetime, discussionId: props.discussionId, disabled, availability };
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const sending = React.useRef<Readonly<{ accountLifetime: ServerAccountScopeLifetime; discussionId: string | undefined }> | null>(null);
    const client = React.useMemo(() => createDiscussionClient({ scope, availability }), [availability, scope]);
    const composerMentions = React.useMemo(
        () => parseComposerStructuredInputMentionsForText(props.value.mentions, props.value.text).mentions,
        [props.value.mentions, props.value.text],
    );

    // The composer reports text and mentions in separate callbacks, in either order. The draft
    // admits a mention only against the text it covers, so both are written together from the
    // latest pair; an external draft replacement (another device, a clear after send) resets it.
    const latestRef = React.useRef<DiscussionComposerValue>({ text: props.value.text, mentions: composerMentions });
    const revisionRef = React.useRef(0);
    const observedValueRef = React.useRef(props.value);
    if (observedValueRef.current !== props.value) {
        observedValueRef.current = props.value;
        if (props.value.text !== latestRef.current.text || !pluginJsonValuesEqual(composerMentions, latestRef.current.mentions)) {
            latestRef.current = { text: props.value.text, mentions: composerMentions };
            revisionRef.current += 1;
        }
    }
    const onChangeRef = React.useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const write = React.useCallback((next: DiscussionComposerValue) => {
        if (next.text !== latestRef.current.text || !pluginJsonValuesEqual(next.mentions, latestRef.current.mentions)) revisionRef.current += 1;
        latestRef.current = next;
        onChangeRef.current({
            text: next.text,
            mentions: parseComposerStructuredInputMentionsForText(next.mentions, next.text).mentions,
        });
    }, []);

    const presenceTarget = React.useMemo(() => props.discussionId
        ? { serverId: props.address.serverId, discussionId: props.discussionId }
        : null, [props.address.serverId, props.discussionId]);
    React.useEffect(() => {
        if (disabled && presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, disabled, presenceTarget]);
    React.useEffect(() => () => {
        if (presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, presenceTarget]);
    const onFocusChange = React.useCallback((focused: boolean) => {
        if (!focused && presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
    }, [accountLifetime, presenceTarget]);

    const onChangeText = React.useCallback((text: string) => {
        if (presenceTarget) reportDiscussionTypingEdit(presenceTarget, text.trim().length > 0, accountLifetime);
        write({ text, mentions: latestRef.current.mentions });
    }, [accountLifetime, presenceTarget, write]);

    const onMentionsChange = React.useCallback((mentions: readonly ComposerStructuredInputMention[]) => {
        const text = latestRef.current.text;
        if (mentions.every((mention) => structuredInputMentionSurvivesText(text, mention))) {
            write({ text, mentions });
            return;
        }
        // Reported ahead of the text it covers: the text change that follows writes both.
        latestRef.current = { text, mentions };
    }, [write]);

    // Retry is a new source, hence a new handler: the open picker asks again for the same token
    // (useActiveSuggestions re-runs its query when the handler changes).
    const [searchRevision, setSearchRevision] = React.useState(0);
    const suggestParticipants = React.useCallback(async (query: string, signal: AbortSignal) => {
        const invited = props.discussionId ? null : props.invited ?? null;
        if (availability !== 'available' || (!props.discussionId && !invited) || !accountLifetime.isCurrent() || signal.aborted) return [];
        // One current roster is the eligibility authority for both picker sections; before create, the
        // chosen invitees are. A Session title is display only; it can never admit an outsider.
        const outcome = props.discussionId ? await client.participants(props.discussionId, signal).catch(() => null) : null;
        if (!accountLifetime.isCurrent() || signal.aborted) return [];
        const sessions: Array<NonNullable<ComposerSuggestionCatalogs['sessions']>[number]> = [];
        const rosterSessionIds = outcome?.kind === 'succeeded'
            ? outcome.value.participants.map(participant => participant.participant.kind === 'session'
                ? participant.participant.sessionId : 'sessionId' in participant ? participant.sessionId ?? null : null)
            : invited ? invited.participants.map(participant => participant.kind === 'session' ? participant.sessionId : null) : [];
        {
            const seen = new Set<string>();
            for (const sessionId of rosterSessionIds) {
                if (!sessionId || seen.has(sessionId)) continue;
                seen.add(sessionId);
                const display = readComposerSessionSuggestionDisplay({ serverId: scope.serverId, sessionId });
                const neutralLabel = t('session.collaboration.discussion.participants.session');
                sessions.push({
                    id: sessionId,
                    title: display?.title || neutralLabel,
                    serverId: scope.serverId,
                    workspaceLabel: display?.workspaceLabel ?? null,
                    agentLabel: display?.agentLabel ?? neutralLabel,
                    agentId: display?.agentId ?? null,
                    machineId: display?.machineId ?? null,
                });
            }
        }
        const accountMentions: ComposerAccountMentionSource = {
            search: async ({ query, limit }) => {
                const people = new Map<string, SessionResponsibilityCandidateV1>();
                if (invited) {
                    for (const participant of invited.participants) {
                        if (participant.kind !== 'account' || participant.accountId === scope.accountId) continue;
                        const profile = invited.accounts.get(participant.accountId)?.profile;
                        people.set(participant.accountId, { accountId: participant.accountId, profile: {
                            name: profile?.name ?? null, firstName: profile?.firstName ?? null, lastName: profile?.lastName ?? null,
                            username: profile?.username ?? null, avatarUrl: profile?.avatarUrl ?? null } });
                    }
                    const matches = [...people.values()].filter((person) => !query || matchesComposerSuggestionQuery(person.profile.name ?? person.profile.username ?? '', query));
                    return { candidates: matches.slice(0, limit), hasMore: matches.length > limit };
                }
                if (outcome?.kind !== 'succeeded') throw new Error('Discussion participants unavailable');
                for (const grant of outcome.value.grants) {
                    if (grant.principal.kind !== 'account' || grant.principal.accountId === scope.accountId) continue;
                    people.set(grant.principal.accountId, {
                        accountId: grant.principal.accountId,
                        profile: { name: grant.display.name, firstName: null, lastName: null, username: grant.display.username ?? null, avatarUrl: null },
                    });
                }
                if (outcome.value.ownerAccountId !== scope.accountId && !people.has(outcome.value.ownerAccountId)) {
                    people.set(outcome.value.ownerAccountId, {
                        accountId: outcome.value.ownerAccountId,
                        profile: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
                    });
                }
                const matches = [...people.values()].filter((person) => !query || matchesComposerSuggestionQuery(person.profile.name ?? person.profile.username ?? '', query));
                return { candidates: matches.slice(0, limit), hasMore: matches.length > limit };
            },
            retry: () => setSearchRevision((revision) => revision + 1),
        };
        const suggestions = await getSuggestions(null, query, {
            kinds: DISCUSSION_COMPOSER_SUGGESTION_KINDS,
            accountMentions,
            // Explicitly empty is authoritative, including after participant removal.
            catalogs: { sessions },
            signal,
        });
        const parsedQuery = parseComposerSuggestionQuery(query);
        if (outcome?.kind === 'succeeded' && parsedQuery?.trigger === '@') {
            const scoped = resolveComposerSuggestionScope('@', parsedQuery.query);
            if (scoped.kind === null || scoped.kind === 'session') {
                const machines = getStorage().getState().machineListByServerId[scope.serverId] ?? [];
                const limit = resolveComposerSuggestionKind('session').limit;
                let sessionCount = suggestions.filter(suggestion => suggestion.kind === 'session').length;
                for (const participant of outcome.value.participants) {
                    if (participant.participant.kind !== 'model' || !('launch' in participant) || participant.sessionId) continue;
                    const display = resolveExecutableModelParticipantDisplay(participant.launch, machines);
                    if (!matchesComposerSuggestionQuery(display.displayLabel, scoped.scopedQuery)) continue;
                    if (sessionCount >= limit) break;
                    const payload = buildDiscussionModelSlotMentionPayload(participant.participant.participantSlotId, display.displayLabel);
                    suggestions.push({ kind: 'session', key: `discussion-model:${participant.participant.participantSlotId}`,
                        text: formatInlineReferenceTokenV1(payload), label: display.displayLabel,
                        structuredInput: payload,
                        ...(display.agentId ? { icon: <SessionAgentCatalogIdentityIcon agentId={display.agentId}
                            machineId={participant.launch.executionTarget.machineId} serverId={scope.serverId} size={16} /> } : {}),
                    });
                    sessionCount++;
                }
            }
        }
        return accountLifetime.isCurrent() && !signal.aborted ? suggestions : [];
        // `searchRevision` renews the active query after the existing Retry action.
    }, [accountLifetime, availability, client, props.discussionId, props.invited, scope.serverId, scope.accountId, searchRevision]);

    const onSendProp = props.onSend;
    const prepareParticipantMentions = props.prepareParticipantMentions;
    const send = React.useCallback(async (options?: AgentInputSendOptions) => {
        const latest = latestRef.current;
        const text = options?.inputTextOverride ?? latest.text;
        const active = sending.current;
        if (disabled || (active?.accountLifetime === accountLifetime && active.discussionId === props.discussionId)
            || text.trim().length === 0 || !accountLifetime.isCurrent()) return;
        if (presenceTarget) stopDiscussionTyping(presenceTarget, accountLifetime);
        const mentions = reconcileStructuredInputMentionsWithText({ previousText: latest.text, nextText: text,
            mentions: parseComposerStructuredInputMentionsForText(latest.mentions, latest.text).mentions });
        if (!mentions.some(mention => readDiscussionMentionParticipant(mention)?.kind === 'model')) {
            onSendProp(buildDiscussionContent(text, mentions));
            return;
        }
        if (!prepareParticipantMentions) return;
        const revision = revisionRef.current;
        const discussionId = props.discussionId;
        const attempt = { accountLifetime, discussionId };
        const isCurrent = () => mounted.current && accountLifetime.isCurrent()
            && currentContext.current.accountLifetime === accountLifetime && currentContext.current.discussionId === discussionId
            && !currentContext.current.disabled && currentContext.current.availability === 'available'
            && revisionRef.current === revision && sending.current === attempt;
        sending.current = attempt;
        try {
            const content = await prepareParticipantMentions({ text, mentions }, isCurrent);
            if (content && isCurrent()) onSendProp(content);
        } finally { if (sending.current === attempt) sending.current = null; }
    }, [accountLifetime, disabled, onSendProp, presenceTarget, prepareParticipantMentions, props.discussionId]);

    const placeholder = t('session.collaboration.discussion.messagePlaceholder');
    // `@` as a control and the one-line addressing rule beside send (lab T2-A): the trigger is written into
    // the document and the field focused, so the composer's own suggestions open on it.
    const focusRequestRef = React.useRef<(() => void) | null>(null);
    const captureFocusRequest = React.useCallback((request: (() => void) | null) => { focusRequestRef.current = request; }, []);
    // The mounted Composer binding also listens for the focus request: one listener per binding feeds both,
    // so a new binding still receives the composer's request.
    type FocusRequestListener = (request: (() => void) | null) => void;
    const focusListenersRef = React.useRef(new WeakMap<FocusRequestListener, FocusRequestListener>());
    const focusRequestListener = (bound: FocusRequestListener | undefined): FocusRequestListener => {
        if (!bound) return captureFocusRequest;
        let listener = focusListenersRef.current.get(bound);
        if (!listener) {
            listener = (request) => { focusRequestRef.current = request; bound(request); };
            focusListenersRef.current.set(bound, listener);
        }
        return listener;
    };
    const insertMention = React.useCallback(() => {
        const latest = latestRef.current;
        const text = latest.text.length === 0 || /\s$/.test(latest.text) ? `${latest.text}@` : `${latest.text} @`;
        write({ text, mentions: latest.mentions });
        requestAnimationFrame(() => focusRequestRef.current?.());
    }, [write]);
    const pageChips = props.extraActionChips;
    const recipients = props.recipients;
    const mentionChips = React.useMemo(() => {
        const recipientChip = recipients ? createRecipientMultiSelectActionChip({ isReadOnly: disabled, model: recipients }) : undefined;
        return [...(recipientChip ? [recipientChip] : []), createMentionActionChip({
            label: t('session.collaboration.discussion.composer.mention'),
            disabled,
            onMention: insertMention,
        }), ...(pageChips ?? [])];
    }, [disabled, insertMention, pageChips, recipients]);
    const phone = useSurfaceStateSize() === 'phone';
    // A new Discussion's page says how addressing works itself, so the line beside send is for a running thread.
    const addressingHint = phone || !props.discussionId ? undefined : <Text testID="session-discussion-composer-hint" style={styles.hint} numberOfLines={1}>{t('session.collaboration.discussion.composer.mentionHint')}</Text>;
    const readDocument = React.useCallback(() => ({ ...latestRef.current, revision: revisionRef.current }), []);
    const composer = React.useMemo(() => props.discussionId
        ? { kind: 'discussion' as const, discussionId: props.discussionId } : null, [props.discussionId]);
    const renderInput = (binding: Partial<React.ComponentProps<typeof AgentInput>> = {}, focusChanged?: (focused: boolean) => void) => {
        return (
            <AgentInput
                {...binding}
                onComposerFocusRequestChange={focusRequestListener(binding.onComposerFocusRequestChange)}
                extraActionChips={binding.extraActionChips ?? mentionChips}
                trailingAccessory={addressingHint}
                value={props.value.text}
                placeholder={placeholder}
                inputAccessibilityLabel={placeholder}
                submitAccessibilityLabel={t('common.send')}
                onChangeText={onChangeText}
                structuredInputMentions={composerMentions}
                onStructuredInputMentionsChange={onMentionsChange}
                onComposerFocusChange={(focused) => { onFocusChange(focused); focusChanged?.(focused); }}
                onSend={send}
                disabled={disabled}
                autocompleteKinds={DISCUSSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={suggestParticipants}
                engineControls="none"
                voiceAffordance="dictation"
                messageHistory="none"
                promptLibrary="none"
                // The roster (or, before create, the chosen invitees) is who can be addressed; no Account-wide Recent.
                referenceRecents="none"
            />
        );
    };
    return (
        <View testID="session-discussion-composer-root" style={styles.root}>
            {composer ? <DiscussionComposerMount
                key={JSON.stringify([scope.serverId, scope.accountId, composer.discussionId])}
                composer={composer} scope={scope} lifetime={accountLifetime}
                available={availability === 'available'} disabled={disabled}
                readDocument={readDocument} writeDocument={write}
            >{(binding, focusChanged) => <DiscussionComposerPluginContributions
                composer={composer} lifetime={accountLifetime} enabled={availability === 'available'}
            >{slots => <>
                {/* A plugin's line sits in the composer's column, as in a Session (one auxiliary frame owner). */}
                {React.Children.count(slots.beforeComposer) > 0 ? <ComposerAuxiliaryFrame>{slots.beforeComposer}</ComposerAuxiliaryFrame> : null}
                {renderInput({ ...binding, extraActionChips: [...mentionChips, ...slots.extraActionChips] }, focusChanged)}
                {React.Children.count(slots.afterComposer) > 0 ? <ComposerAuxiliaryFrame>{slots.afterComposer}</ComposerAuxiliaryFrame> : null}
            </>}</DiscussionComposerPluginContributions>}</DiscussionComposerMount> : renderInput()}
        </View>
    );
}
