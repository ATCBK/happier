import * as React from 'react';
import type {
    SessionDraftAddressV2,
    StrictJsonValue,
} from '@happier-dev/protocol';
import { canonicalSessionDraftAddressV2, DiscussionDraftDocumentV2Schema, type DiscussionDraftSubmittedContentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import type { DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    flushSessionDraft,
    flushSessionDraftLocally,
    getSessionComposerDraftSnapshot,
    getSessionDraftSnapshot,
    purgeSessionDraftPresentation,
    subscribeSessionDraft,
    writeDiscussionSessionDraft,
    writeSessionDraftLocalSupplement,
    type SessionDiscussionDraftMutationAttempt,
    type SessionDiscussionDraftMutationAttemptInput,
    type SessionDraftConflict,
    type SessionDraftStatus,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';

import {
    prepareDiscussionContentForPassage,
    prepareDiscussionContentForRecipients,
    buildDiscussionContent,
    resolveDiscussionCreationTitle,
} from './discussionComposerDocument';

import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { reconcileStructuredInputMentionsWithText, type ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

export type DiscussionDraftAddress = Extract<
    SessionDraftAddressV2,
    { kind: 'discussion' | 'newDiscussion' }
>;

export type DiscussionDraftContentOptions = Readonly<{
    replyTarget?: DiscussionReplyTargetV1;
    passage?: DocPassageRefV1 | null;
    /** The selection owner admits persisted defaults against the current roster. */
    recipients?: readonly DiscussionParticipantRefV1[];
}>;

export type DiscussionDraft = Readonly<{
    title: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    recipients: readonly DiscussionParticipantRefV1[];
    setRecipients(recipients: readonly DiscussionParticipantRefV1[]): void;
    replyTarget: DiscussionReplyTargetV1 | null;
    setReplyTarget(replyTarget: DiscussionReplyTargetV1 | null): void;
    /** New Discussion only: the people and agents invited at create (never who a message addresses). */
    participants: readonly DiscussionParticipantRefV1[];
    setParticipants(participants: readonly DiscussionParticipantRefV1[]): void;
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
    setPassage(passage: DocPassageRefV1 | null): void;
    prepareContent(content: DiscussionMessageContentV1, options?: DiscussionDraftContentOptions): DiscussionMessageContentV1;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    setTitle(title: string): void;
    setText(text: string): void;
    setMentions(mentions: readonly ComposerStructuredInputMention[]): void;
    setComposer(value: Readonly<{
        text: string;
        mentions: readonly ComposerStructuredInputMention[];
    }>): void;
    pendingMutationAttempt: SessionDiscussionDraftMutationAttempt | null;
    captureSubmittedCurrentness(attempt?: SessionDiscussionDraftMutationAttemptInput,
        submitted?: Readonly<{ content: DiscussionMessageContentV1; title?: string }>): DiscussionDraftSubmission;
    clearAfterObservedSuccess(submission: DiscussionDraftSubmission): Promise<boolean>;
    /**
     * Forgets a refused retry identity without touching the drafted fields, so
     * a remount adopts nothing and the retained text is sent as a fresh attempt.
     */
    releaseSubmittedAttempt(): void;
    purgePresentation(): Promise<void>;
    purgeSourcePresentation(): Promise<void>;
}>;

const COMPOSER_FIELD_IDS = ['composer.text', 'composer.mentions', 'passage', 'submission'] as const;
const SUBMITTED_FIELD_IDS = [...COMPOSER_FIELD_IDS, 'replyTarget'] as const;
const NEW_DISCUSSION_FIELD_IDS = [...SUBMITTED_FIELD_IDS, 'title', 'participants'] as const;
const NO_RECIPIENTS: readonly DiscussionParticipantRefV1[] = Object.freeze([]);

function readDiscussionComposerSnapshot(scope: ServerAccountScope, address: DiscussionDraftAddress) {
    const snapshot = getSessionComposerDraftSnapshot(scope, address);
    return snapshot?.targetKind === address.kind ? snapshot : null;
}

function readDiscussionDraftFields(
    scope: ServerAccountScope,
    address: DiscussionDraftAddress,
): Readonly<{
    title: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
    recipients: readonly DiscussionParticipantRefV1[];
    recipientsMutationId?: string;
    replyTarget: DiscussionReplyTargetV1 | null;
    replyTargetMutationId?: string;
    participants: readonly DiscussionParticipantRefV1[];
    participantsMutationId?: string;
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
}> {
    const snapshot = readDiscussionComposerSnapshot(scope, address);
    const parsedDocument = DiscussionDraftDocumentV2Schema.safeParse(getSessionDraftSnapshot(scope, address)?.document);
    const document = parsedDocument.success ? parsedDocument.data : null;
    const text = typeof snapshot?.composer.text.value === 'string'
        ? snapshot.composer.text.value
        : '';
    return {
        title: address.kind === 'newDiscussion'
            && document?.target.kind === 'newDiscussion'
            && document.title
            && typeof document.title.value === 'string'
            ? document.title.value
            : '',
        text,
        mentions: parseComposerStructuredInputMentionsForText(snapshot?.composer.mentions.value, text).mentions,
        recipients: document?.recipients?.value ?? NO_RECIPIENTS,
        recipientsMutationId: document?.recipients?.mutationId,
        replyTarget: document?.replyTarget?.value ?? null,
        replyTargetMutationId: document?.replyTarget?.mutationId,
        participants: document?.participants?.value ?? NO_RECIPIENTS,
        participantsMutationId: document?.participants?.mutationId,
        passage: document?.passage?.value ?? null,
        submitted: document?.submission?.value ?? null,
    };
}

function mentionValues(mentions: readonly ComposerStructuredInputMention[]): readonly StrictJsonValue[] {
    return mentions.map(mention => StrictJsonValueSchema.parse(mention));
}

function sameAddress(left: DiscussionDraftAddress, right: DiscussionDraftAddress): boolean {
    return canonicalSessionDraftAddressV2(left) === canonicalSessionDraftAddressV2(right);
}

function sameScope(left: ServerAccountScope, right: ServerAccountScope): boolean {
    return left.serverId === right.serverId && left.accountId === right.accountId;
}

/**
 * An explicit "Ask <someone>" from elsewhere in the app: fills an empty draft with an addressed request
 * the person still reads and sends — a new Discussion (with its title), or a reply in an existing one.
 * Words already in that draft are never replaced.
 */
export function seedDiscussionDraft(input: Readonly<{
    scope: ServerAccountScope;
    address?: DiscussionDraftAddress;
    title?: string;
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): boolean {
    const address: DiscussionDraftAddress = input.address ?? { kind: 'newDiscussion' };
    const current = readDiscussionDraftFields(input.scope, address);
    if (current.text.trim() || current.title.trim()) return false;
    writeDiscussionSessionDraft({
        scope: input.scope,
        address,
        patch: { ...(address.kind === 'newDiscussion' && input.title !== undefined ? { title: input.title } : {}),
            text: input.text, mentions: mentionValues(parseComposerStructuredInputMentionsForText(input.mentions, input.text).mentions) },
    });
    return true;
}

/**
 * React projection over the synchronized V2 draft repository. This hook owns
 * no persistence, retry queue or draft lifecycle; desktop and mobile consumers
 * therefore observe the same exact Home/Account/address document.
 */
export function useDiscussionDraft(params: Readonly<{
    scope: ServerAccountScope;
    address: DiscussionDraftAddress;
}>): DiscussionDraft {
    const scope = React.useMemo<ServerAccountScope>(() => ({
        serverId: params.scope.serverId,
        accountId: params.scope.accountId,
    }), [params.scope.accountId, params.scope.serverId]);
    const addressKey = canonicalSessionDraftAddressV2(params.address);
    const address = React.useMemo<DiscussionDraftAddress>(() => params.address, [addressKey]);
    const subscribe = React.useCallback(
        (listener: () => void) => subscribeSessionDraft(scope, address, listener),
        [address, scope],
    );
    const readSnapshot = React.useCallback(
        () => readDiscussionComposerSnapshot(scope, address),
        [address, scope],
    );
    const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    const fields = React.useMemo(() => readDiscussionDraftFields(scope, address), [snapshot, scope, address]);
    const text = fields.text;
    const mentions = React.useMemo(
        () => parseComposerStructuredInputMentionsForText(snapshot?.composer.mentions.value, text).mentions,
        [snapshot?.composer.mentions.value, text],
    );
    const title = fields.title;
    const passage = fields.passage;
    const replyTarget = React.useMemo(() => fields.replyTarget, [fields.replyTargetMutationId, scope, address]);
    // The canonical field mutation id binds its immutable value. Text edits
    // clone the private document but must not rebuild the recipient picker.
    const recipients = React.useMemo(() => fields.recipients, [fields.recipientsMutationId, scope, address]);
    const participants = React.useMemo(() => fields.participants, [fields.participantsMutationId, scope, address]);
    const attempt = snapshot?.localSupplement.discussionMutationAttempt;
    const attemptLocalId = attempt?.kind === 'create' ? attempt.creationLocalId : attempt?.localId;
    const submitted = attemptLocalId && fields.submitted?.attemptLocalId === attemptLocalId ? fields.submitted : null;
    const setPassage = React.useCallback((value: DocPassageRefV1 | null) => {
        writeDiscussionSessionDraft({ scope, address, patch: { passage: value } });
    }, [address, scope]);
    const setRecipients = React.useCallback((value: readonly DiscussionParticipantRefV1[]) => {
        writeDiscussionSessionDraft({ scope, address, patch: { recipients: value } });
    }, [address, scope]);
    const setReplyTarget = React.useCallback((value: DiscussionReplyTargetV1 | null) => {
        writeDiscussionSessionDraft({ scope, address, patch: { replyTarget: value } });
    }, [address, scope]);
    const setParticipants = React.useCallback((value: readonly DiscussionParticipantRefV1[]) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion invites through the participant Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { participants: value } });
    }, [address, scope]);
    const prepareContent = React.useCallback((content: DiscussionMessageContentV1,
        options?: DiscussionDraftContentOptions): DiscussionMessageContentV1 => {
        const basis = readDiscussionDraftFields(scope, address);
        return prepareDiscussionContentForPassage({ content: prepareDiscussionContentForRecipients({
            content, recipients: options?.recipients ?? basis.recipients, replyTarget: options?.replyTarget ?? basis.replyTarget ?? undefined,
        }), passage: basis.passage ?? options?.passage });
    }, [address, scope]);

    const setComposer = React.useCallback((value: Readonly<{
        text: string;
        mentions: readonly ComposerStructuredInputMention[];
    }>) => {
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: value.text,
                mentions: mentionValues(parseComposerStructuredInputMentionsForText(value.mentions, value.text).mentions),
            },
        });
    }, [address, scope]);

    const setText = React.useCallback((nextText: string) => {
        const current = readDiscussionDraftFields(scope, address);
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: nextText,
                mentions: mentionValues(reconcileStructuredInputMentionsWithText({
                    previousText: current.text,
                    nextText,
                    mentions: current.mentions,
                })),
            },
        });
    }, [address, scope]);

    const setMentions = React.useCallback((nextMentions: readonly ComposerStructuredInputMention[]) => {
        const currentText = readDiscussionDraftFields(scope, address).text;
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: { mentions: mentionValues(parseComposerStructuredInputMentionsForText(nextMentions, currentText).mentions) },
        });
    }, [address, scope]);

    const setTitle = React.useCallback((nextTitle: string) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion title is changed through the rename Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { title: nextTitle } });
    }, [address, scope]);

    const captureSubmittedCurrentness = React.useCallback((attempt?: SessionDiscussionDraftMutationAttemptInput,
        submitted?: Readonly<{ content: DiscussionMessageContentV1; title?: string }>): DiscussionDraftSubmission => {
        if (attempt) {
            const current = readDiscussionDraftFields(scope, address);
            const content = submitted?.content ?? prepareDiscussionContentForPassage({ content: prepareDiscussionContentForRecipients({
                content: buildDiscussionContent(current.text, current.mentions), recipients: current.recipients,
                replyTarget: attempt.replyTarget ?? current.replyTarget ?? undefined,
            }), passage: current.passage });
            const title = attempt.kind === 'create' ? submitted?.title ?? resolveDiscussionCreationTitle({ title: current.title, text: current.text }) ?? undefined : undefined;
            writeDiscussionSessionDraft({ scope, address, patch: { submission: {
                attemptLocalId: attempt.kind === 'create' ? attempt.creationLocalId : attempt.localId,
                content, ...(title === undefined ? {} : { title }),
            } } });
        }
        const currentness = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...SUBMITTED_FIELD_IDS],
        });
        if (attempt) {
            writeSessionDraftLocalSupplement({
                scope,
                address,
                patch: { discussionMutationAttempt: { ...attempt, currentness } as SessionDiscussionDraftMutationAttempt },
            });
        }
        return {
            scope,
            address,
            currentness,
        };
    }, [address, scope]);

    const clearAfterObservedSuccess = React.useCallback(async (
        submission: DiscussionDraftSubmission,
    ): Promise<boolean> => {
        if (!sameScope(submission.scope, scope) || !sameAddress(submission.address, address)) return false;
        const current = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...SUBMITTED_FIELD_IDS],
        });
        const capturedText = submission.currentness.mutationIds['composer.text'];
        const capturedMentions = submission.currentness.mutationIds['composer.mentions'];
        const composerIsCurrent = capturedText !== undefined
            && capturedMentions !== undefined
            && current.mutationIds['composer.text'] === capturedText
            && current.mutationIds['composer.mentions'] === capturedMentions;
        const titleIsCurrent = address.kind === 'newDiscussion'
            && submission.currentness.mutationIds.title !== undefined
            && current.mutationIds.title === submission.currentness.mutationIds.title;
        // The invitees were sent with this create; a later change to them stays for the next one.
        const participantsIsCurrent = address.kind === 'newDiscussion'
            && submission.currentness.mutationIds.participants !== undefined
            && current.mutationIds.participants === submission.currentness.mutationIds.participants;
        const fieldIds = [
            ...(composerIsCurrent ? COMPOSER_FIELD_IDS : []),
            ...(!composerIsCurrent ? ['submission' as const] : []),
            ...(titleIsCurrent ? ['title' as const] : []),
            ...(participantsIsCurrent ? ['participants' as const] : []),
            // A newer Reply choice belongs to the next post even if its text is unchanged.
            'replyTarget' as const,
        ];
        // Field currentness decides which drafted fields are cleared, never
        // whether the attempt is retired. The attempt identifies a submission
        // the server already accepted, so once every captured field has moved
        // on there is nothing to clear and the identity must still go — keeping
        // it would let a remount adopt an accepted create/post and repeat it.
        // Local recovery custody must complete before navigation; a remote
        // draft acknowledgement cannot hold an already committed Discussion open.
        const cleared = clearSessionDraftCurrentnessLocal({
            scope,
            address,
            currentness: submission.currentness,
            fieldIds,
        });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
        await flushSessionDraftLocally({ scope });
        // The canonical draft synchronizer retains the pending clear on failure.
        // It is independent of opening the committed resource.
        void flushSessionDraft({ scope, address }).catch(() => undefined);
        return cleared;
    }, [address, scope]);

    const releaseSubmittedAttempt = React.useCallback((): void => {
        writeDiscussionSessionDraft({ scope, address, patch: { submission: null } });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
    }, [address, scope]);

    const purgePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address });
    }, [address, scope]);
    const purgeSourcePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address, fieldIds: ['passage', 'submission', 'replyTarget'] });
    }, [address, scope]);

    return React.useMemo(() => ({
        title,
        text,
        mentions,
        recipients,
        setRecipients,
        replyTarget,
        setReplyTarget,
        participants,
        setParticipants,
        passage,
        submitted,
        setPassage,
        prepareContent,
        pendingMutationAttempt: snapshot?.localSupplement.discussionMutationAttempt ?? null,
        status: snapshot?.status ?? 'clean',
        conflict: snapshot?.conflict ?? null,
        setTitle,
        setText,
        setMentions,
        setComposer,
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
    }), [
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
        mentions,
        recipients,
        setRecipients,
        replyTarget,
        setReplyTarget,
        participants,
        setParticipants,
        passage,
        submitted,
        setPassage,
        prepareContent,
        snapshot?.localSupplement.discussionMutationAttempt,
        setComposer,
        setMentions,
        setText,
        setTitle,
        snapshot?.conflict,
        snapshot?.status,
        text,
        title,
    ]);
}
