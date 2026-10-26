import * as React from 'react';
import { canonicalSessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { DiscussionDraftAddress } from './useDiscussionDraft';
import { prepareAttachmentPayloads, type PreparedAttachmentPayloads } from '@/sync/domains/attachments/prepareAttachmentPayloads';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { DiscussionMutationStatus, DiscussionRepositoryMutation } from '@/sync/ops/discussions/discussionRepository';
import type { PreparedAttachmentSource } from '@/sync/domains/attachments/prepareAttachmentPayloads';
import { discussionFailureLabel } from './discussionFailureLabel';

export type DiscussionAttachmentSubmission = PreparedAttachmentPayloads & Readonly<{ drafts: readonly AttachmentDraft[] }>;
type PreparationOptions = Omit<Parameters<typeof prepareAttachmentPayloads>[0], 'drafts' | 'maxFileBytes'>;

export type DiscussionAttachmentDraftOptions = Readonly<{
    scope: ServerAccountScope;
    address: DiscussionDraftAddress;
    enabled: boolean;
    maxFileBytes: number;
    onPickedDrafts?: Parameters<typeof useAttachmentDraftManager>[0]['onPickedDrafts'];
    onRemoveDraft?: Parameters<typeof useAttachmentDraftManager>[0]['onRemoveDraft'];
}>;

/** The mounted Discussion document binds the existing shared intake owner. */
export function useDiscussionAttachmentDrafts(options: DiscussionAttachmentDraftOptions) {
    const key = serverAccountScopedResourceKey(options.scope, canonicalSessionDraftAddressV2(options.address));
    const mountedKey = React.useRef(key);
    const mounted = React.useRef(true);
    const manager = useAttachmentDraftManager({ enabled: options.enabled, maxFileBytes: options.maxFileBytes,
        memoryKey: key,
        onPickedDrafts: options.onPickedDrafts, onRemoveDraft: options.onRemoveDraft });
    const { getDraftsSnapshot, applyDraftPatch, removeSubmittedDrafts } = manager;
    React.useLayoutEffect(() => {
        mounted.current = true;
        mountedKey.current = key;
        return () => { mounted.current = false; };
    }, [key]);
    const settleSubmission = React.useCallback((drafts: readonly AttachmentDraft[], status: DiscussionMutationStatus, errorCode?: string) => {
        // The captured manager settles its original memory address even after
        // navigation; it never consults a successor tray's mutable key.
        if (status === 'observed_success') { removeSubmittedDrafts(drafts); return; }
        const failed = (status === 'failed' || status === 'outcome_unknown') && errorCode !== 'canceled';
        // The tray says the reason a person can act on (the repository's refusal vocabulary), not the code.
        const error = failed ? discussionFailureLabel(status === 'outcome_unknown' ? 'outcome_unknown' : errorCode ?? 'outcome_unknown') : undefined;
        for (const draft of drafts) applyDraftPatch(draft.id, {
            status: failed ? 'error' : status === 'sending' ? 'uploading' : 'pending',
            error,
            uploadProgress: undefined,
        }, draft.source);
    }, [applyDraftPatch, removeSubmittedDrafts]);
    const prepareSubmission = React.useCallback(async (input: PreparationOptions = {}): Promise<DiscussionAttachmentSubmission> => {
        const isCurrent = () => mounted.current && mountedKey.current === key && input.isCurrent?.() !== false;
        if (!isCurrent() || input.signal?.aborted) throw Object.assign(new Error('Attachment preparation canceled'), { code: 'canceled' });
        if (!options.enabled) throw Object.assign(new Error('Attachment intake is unavailable'), { code: 'unsupported_action' });
        const drafts = getDraftsSnapshot();
        settleSubmission(drafts, 'sending');
        try {
            const prepared = await prepareAttachmentPayloads({ ...input, drafts, maxFileBytes: options.maxFileBytes, isCurrent });
            return { ...prepared, drafts };
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
                : input.signal?.aborted ? 'canceled' : 'attachment_source_unavailable';
            settleSubmission(drafts, 'failed', code);
            throw error;
        }
    }, [getDraftsSnapshot, key, options.enabled, options.maxFileBytes, settleSubmission]);
    return { ...manager, prepareSubmission, settleSubmission };
}

/**
 * What a send hands its page: the process-local sources for the create/post, and the captured tray
 * settlement (an observed success removes only these files; a refusal keeps them with its reason).
 */
export type DiscussionAttachmentSendSubmission = Readonly<{
    sources: readonly PreparedAttachmentSource[];
    settle: (status: DiscussionMutationStatus, errorCode?: string) => void;
}>;

type MutationFacts = Pick<DiscussionRepositoryMutation, 'status' | 'errorCode'>;

/**
 * Feeds each tracked send's repository mutation status to its tray, including later transitions
 * (a Retry that succeeds, a checking send that turns out committed). Returns `track(localId, submission, mutation)`.
 */
export function useDiscussionAttachmentSettlement(mutations: Readonly<Record<string, MutationFacts | undefined>>) {
    const tracked = React.useRef(new Map<string, { settle: DiscussionAttachmentSendSubmission['settle']; seen: string | null }>());
    const apply = React.useCallback((current: Readonly<Record<string, MutationFacts | undefined>>) => {
        for (const [localId, entry] of tracked.current) {
            const mutation = current[localId];
            if (!mutation) {
                // Dismissed or acknowledged after we saw it: its last settlement stands.
                if (entry.seen !== null) tracked.current.delete(localId);
                continue;
            }
            const seen = `${mutation.status}:${mutation.errorCode ?? ''}`;
            if (seen === entry.seen) continue;
            entry.seen = seen;
            entry.settle(mutation.status, mutation.errorCode);
            if (mutation.status === 'observed_success') tracked.current.delete(localId);
        }
    }, []);
    const latest = React.useRef(mutations);
    latest.current = mutations;
    React.useEffect(() => { apply(mutations); }, [apply, mutations]);
    return React.useCallback(async <T extends Readonly<{ kind: string }>>(localId: string, submission: DiscussionAttachmentSendSubmission, mutation: Promise<T>): Promise<T> => {
        tracked.current.set(localId, { settle: submission.settle, seen: null });
        apply(latest.current);
        const outcome = await mutation;
        // A committed send can be acknowledged (and its mutation dropped) before a render observes it;
        // the create/post's own success is the same observed success.
        if (outcome.kind === 'succeeded' && tracked.current.has(localId)) {
            tracked.current.delete(localId);
            submission.settle('observed_success');
        }
        return outcome;
    }, [apply]);
}
