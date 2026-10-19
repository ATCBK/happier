import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { renderHook } from '@/dev/testkit';
import {
    getSessionComposerDraftSnapshot,
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    purgeSessionDraftPresentation,
    writeDiscussionSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';

import { seedDiscussionDraft, useDiscussionDraft } from './useDiscussionDraft';

const scope = { serverId: 'discussion-draft-home', accountId: 'discussion-draft-account' } as const;
const newAddress = { kind: 'newDiscussion' } as const;
const existingAddress = {
    kind: 'discussion',
    discussionId: 'discussion-draft-existing',
} as const;

afterEach(() => {
    resetSessionDraftRepositoryForTests();
});

describe('useDiscussionDraft', () => {
    it('retains only the selected model slot identity across editing and remount before any Send', async () => {
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: {
            text: '@Model', mentions: [{ start: 0, end: 6, participantSlotId: 'saved-model-slot' }],
        } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(first.getCurrent().mentions).toEqual([{ start: 0, end: 6, participantSlotId: 'saved-model-slot' }]);
        act(() => first.getCurrent().setText('Ask @Model'));
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().mentions).toEqual([{ start: 4, end: 10, participantSlotId: 'saved-model-slot' }]);
        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer.mentions.value)
            .toEqual([{ start: 4, end: 10, participantSlotId: 'saved-model-slot' }]);
        expect(restored.getCurrent().pendingMutationAttempt).toBeNull();
        await restored.unmount();
    });
    it('switches keyed route drafts without borrowing subscriptions or clearing another draft submission', async () => {
        const firstAddress = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000001' };
        const secondAddress = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000002' };
        for (const [address, text] of [[newAddress, 'Unrelated singleton'], [firstAddress, 'First passage'], [secondAddress, 'Second passage']] as const) {
            writeDiscussionSessionDraft({ scope, address, patch: { text, mentions: [] } });
        }
        const hook = await renderHook(({ address }) => useDiscussionDraft({ scope, address }), { initialProps: { address: firstAddress } });
        let first: DiscussionDraftSubmission | undefined;
        act(() => { first = hook.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'first-create', messageLocalId: 'first-message' }); });
        await hook.rerender({ address: secondAddress });
        expect(hook.getCurrent().text).toBe('Second passage');
        act(() => { hook.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'second-create', messageLocalId: 'second-message' }); });
        await act(async () => { expect(await hook.getCurrent().clearAfterObservedSuccess(first!)).toBe(false); });
        expect(hook.getCurrent().text).toBe('Second passage');
        expect(hook.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'second-create' });
        await hook.rerender({ address: firstAddress });
        expect(hook.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'first-create' });
        await act(async () => { await hook.getCurrent().clearAfterObservedSuccess(first!); });
        expect(hook.getCurrent().text).toBe('');
        expect(getSessionComposerDraftSnapshot(scope, secondAddress)?.composer.text.value).toBe('Second passage');
        expect(getSessionComposerDraftSnapshot(scope, newAddress)?.composer.text.value).toBe('Unrelated singleton');
        await hook.unmount();
    });
    it('retains a qualified passage and retry identity across remount, then clears only the submitted basis', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 2, bodyVersion: 4 }, range: { start: 12, end: 18 }, quote: 'second' };
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { text: 'Please review', mentions: [], passage } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(first.getCurrent().passage).toEqual(passage);
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = first.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'stable-thread', messageLocalId: 'stable-comment' }); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(restored.getCurrent().prepareContent({ v: 1, parts: [{ t: 'text', text: 'Please review' }] }))
            .toEqual({ kind: 'doc_passage_comment', passage, content: { v: 1, parts: [{ t: 'text', text: 'Please review' }] } });
        expect(restored.getCurrent().pendingMutationAttempt).toMatchObject({ creationLocalId: 'stable-thread', messageLocalId: 'stable-comment' });
        await act(async () => { await restored.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(restored.getCurrent().passage).toBeNull();
        expect(restored.getCurrent().text).toBe('');
        await restored.unmount();
    });

    it('restores the original uncertain submission after the synchronized draft changes, and purges only source material on refusal', async () => {
        const passage = { ref: { kind: 'doc' as const, artifactId: 'notes', serverId: scope.serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'secret' };
        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { text: 'Original question', passage } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        act(() => { first.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId: 'stable-thread', messageLocalId: 'stable-message' }); });
        act(() => { first.getCurrent().setText('Newer authored question'); first.getCurrent().setPassage({ ...passage, ref: { ...passage.ref, artifactId: 'other-doc' } }); });
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(restored.getCurrent().submitted).toMatchObject({ attemptLocalId: 'stable-thread',
            content: { kind: 'doc_passage_comment', passage, content: { parts: [{ t: 'text', text: 'Original question' }] } } });
        await restored.unmount();
        await purgeSessionDraftPresentation({ scope, address: newAddress, fieldIds: ['passage', 'submission'] });
        const afterRefusal = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(afterRefusal.getCurrent().passage).toBeNull();
        expect(afterRefusal.getCurrent().submitted).toBeNull();
        expect(afterRefusal.getCurrent().text).toBe('Newer authored question');
        await afterRefusal.unmount();
    });

    it('preserves typed participant identities after restoring and synchronizing a draft, then editing it', async () => {
        const spans: JsonValue[] = [
            { start: 0, end: 5, accountId: 'account-alex' },
            { start: 6, end: 11, sessionId: 'session-alex' },
        ];
        writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: '@Alex @Alex', mentions: spans } });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(first.getCurrent().mentions).toEqual(spans);
        await first.unmount();
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().mentions).toEqual(spans);
        act(() => writeDiscussionSessionDraft({ scope, address: existingAddress, patch: {
            text: 'Ask @Alex', mentions: [{ start: 4, end: 9, sessionId: 'session-alex' }],
        } }));
        await vi.waitFor(() => expect(restored.getCurrent().text).toBe('Ask @Alex'));
        act(() => restored.getCurrent().setText('Please Ask @Alex'));
        expect(restored.getCurrent().mentions).toEqual([{ start: 11, end: 16, sessionId: 'session-alex' }]);
        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer.mentions.value).toEqual([
            { start: 11, end: 16, sessionId: 'session-alex' },
        ]);
        await restored.unmount();
    });

    it('projects one exact synchronized V2 draft and updates it through the repository owner', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: {
                title: 'Release review',
                text: 'Ask @Alex',
                mentions: [
                    { start: 4, end: 9, accountId: 'account-alex' },
                    { start: 40, end: 50, accountId: 'forged-outside' },
                ],
            },
        });

        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(rendered.getCurrent()).toMatchObject({
            title: 'Release review',
            text: 'Ask @Alex',
            mentions: [{ start: 4, end: 9, accountId: 'account-alex' }],
            status: 'clean',
            conflict: null,
        });

        const draftBeforeWrite = rendered.getCurrent();
        act(() => {
            draftBeforeWrite.setComposer({
                text: 'Ask @Alex and @Bob',
                mentions: [
                    { start: 4, end: 9, accountId: 'account-alex' },
                    { start: 14, end: 18, accountId: 'account-bob' },
                ],
            });
        });
        expect(draftBeforeWrite.captureSubmittedCurrentness()).toMatchObject({
            scope,
            address: newAddress,
            currentness: { address: newAddress },
        });
        await vi.waitFor(() => expect(rendered.getCurrent().text).toBe('Ask @Alex and @Bob'));
        expect(rendered.getCurrent().mentions).toHaveLength(2);

        act(() => rendered.getCurrent().setText('Ask @Bert and @Bob'));
        await vi.waitFor(() => expect(rendered.getCurrent().text).toBe('Ask @Bert and @Bob'));
        expect(rendered.getCurrent().mentions).toEqual([
            { start: 14, end: 18, accountId: 'account-bob' },
        ]);
        await rendered.unmount();
    });

    it('clears only the captured post fields after observed success and preserves a newer concurrent edit', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: {
                text: 'Captured @Alex',
                mentions: [{ start: 9, end: 14, accountId: 'account-alex' }],
            },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setComposer({
                text: 'Newer @Alex edit',
                mentions: [{ start: 6, end: 11, accountId: 'account-alex' }],
            });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: 'Newer @Alex edit' },
            mentions: { value: [{ start: 6, end: 11, accountId: 'account-alex' }] },
        });
        await rendered.unmount();
    });

    it('restores and clears the same crash-stable post retry identity through the draft supplement', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Retry me', mentions: [] },
        });
        const first = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        let submitted: DiscussionDraftSubmission | null = null;
        act(() => {
            submitted = first.getCurrent().captureSubmittedCurrentness({
                kind: 'post',
                discussionId: existingAddress.discussionId,
                localId: 'post-local-stable',
            });
        });
        await first.unmount();

        const restored = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        expect(restored.getCurrent().pendingMutationAttempt).toMatchObject({
            kind: 'post',
            discussionId: existingAddress.discussionId,
            localId: 'post-local-stable',
            currentness: submitted!.currentness,
        });
        await act(async () => {
            await restored.getCurrent().clearAfterObservedSuccess(submitted!);
        });
        expect(restored.getCurrent().pendingMutationAttempt).toBeNull();
        await restored.unmount();
    });

    it('releases a refused retry identity while keeping the drafted text for a fresh attempt', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Refused once', mentions: [] },
        });
        const hook = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        act(() => {
            hook.getCurrent().captureSubmittedCurrentness({
                kind: 'post',
                discussionId: existingAddress.discussionId,
                localId: 'post-local-refused',
            });
        });
        expect(hook.getCurrent().pendingMutationAttempt).not.toBeNull();

        act(() => {
            hook.getCurrent().releaseSubmittedAttempt();
        });

        expect(hook.getCurrent().pendingMutationAttempt).toBeNull();
        expect(hook.getCurrent().text).toBe('Refused once');
        await hook.unmount();
    });

    it('preserves a newer mention-only edit when accepted text is unchanged', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Captured @Alex', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setMentions([{ start: 9, end: 14, accountId: 'account-alex' }]);
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: 'Captured @Alex' },
            mentions: { value: [{ start: 9, end: 14, accountId: 'account-alex' }] },
        });
        await rendered.unmount();
    });

    it('preserves a newer text-only edit when accepted mentions are unchanged', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Captured text', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            writeDiscussionSessionDraft({ scope, address: existingAddress, patch: { text: 'Newer text' } });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)?.composer).toMatchObject({
            text: { value: 'Newer text' },
            mentions: { value: [] },
        });
        await rendered.unmount();
    });

    it('preserves a newer grouped composer edit and a newer title', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: { title: 'Accepted title', text: 'Captured @Alex', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();

        act(() => {
            rendered.getCurrent().setTitle('Newer title');
            rendered.getCurrent().setMentions([{ start: 9, end: 14, accountId: 'account-alex' }]);
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });

        expect(getSessionDraftSnapshot(scope, newAddress)?.document).toMatchObject({
            title: { value: 'Newer title' },
            composer: {
                text: { value: 'Captured @Alex' },
                mentions: { value: [{ start: 9, end: 14, accountId: 'account-alex' }] },
            },
        });
        await rendered.unmount();
    });

    it('clears captured create fields together and lets the repository contract the empty draft', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: newAddress,
            patch: {
                title: 'Captured title',
                text: 'Captured text',
                mentions: [],
            },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        const submitted = rendered.getCurrent().captureSubmittedCurrentness();
        let cleared = false;
        await act(async () => {
            cleared = await rendered.getCurrent().clearAfterObservedSuccess(submitted);
        });
        expect(cleared).toBe(true);

        expect(getSessionComposerDraftSnapshot(scope, newAddress)).toBeNull();
        await rendered.unmount();
    });

    it.each([
        ['create', newAddress] as const,
        ['post', existingAddress] as const,
    ])('retires the %s mutation attempt after observed success even when every captured field moved on', async (kind, address) => {
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: { ...(kind === 'create' ? { title: 'Captured title' } : {}), text: 'Captured text', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address }));
        let submitted: DiscussionDraftSubmission | null = null;
        act(() => {
            submitted = rendered.getCurrent().captureSubmittedCurrentness(
                kind === 'create'
                    ? { kind: 'create', creationLocalId: 'create-local-stable', messageLocalId: 'create-message-stable' }
                    : { kind: 'post', discussionId: existingAddress.discussionId, localId: 'post-local-stable' },
            );
        });
        expect(rendered.getCurrent().pendingMutationAttempt).not.toBeNull();

        // Every captured field moves on while the mutation is in flight.
        act(() => {
            if (kind === 'create') rendered.getCurrent().setTitle('Newer title');
            rendered.getCurrent().setComposer({
                text: 'Newer @Alex text',
                mentions: [{ start: 6, end: 11, accountId: 'account-alex' }],
            });
        });
        await act(async () => {
            await rendered.getCurrent().clearAfterObservedSuccess(submitted!);
        });

        expect(rendered.getCurrent().pendingMutationAttempt).toBeNull();
        await rendered.unmount();

        const remounted = await renderHook(() => useDiscussionDraft({ scope, address }));
        expect(remounted.getCurrent().pendingMutationAttempt).toBeNull();
        expect(remounted.getCurrent().text).toBe('Newer @Alex text');
        expect(remounted.getCurrent().mentions).toEqual([{ start: 6, end: 11, accountId: 'account-alex' }]);
        if (kind === 'create') expect(remounted.getCurrent().title).toBe('Newer title');
        await remounted.unmount();
    });

    it('purges the local decrypted presentation when access is explicitly lost', async () => {
        writeDiscussionSessionDraft({
            scope,
            address: existingAddress,
            patch: { text: 'Private local draft', mentions: [] },
        });
        const rendered = await renderHook(() => useDiscussionDraft({ scope, address: existingAddress }));

        await act(async () => {
            await rendered.getCurrent().purgePresentation();
        });

        expect(getSessionComposerDraftSnapshot(scope, existingAddress)).toBeNull();
        await rendered.unmount();
    });
    it('seeds an empty new Discussion with an addressed request, and never replaces words already there', async () => {
        const seed = { scope, title: 'Reading desk isn’t ready', text: '@Ana Its machine is offline.',
            mentions: [{ start: 0, end: 4, accountId: 'ana' }] } as const;
        expect(seedDiscussionDraft(seed)).toBe(true);
        const seeded = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(seeded.getCurrent()).toMatchObject({ title: seed.title, text: seed.text, mentions: seed.mentions });
        await seeded.unmount();

        writeDiscussionSessionDraft({ scope, address: newAddress, patch: { title: '', text: 'My own unsent words', mentions: [] } });
        expect(seedDiscussionDraft(seed)).toBe(false);
        const kept = await renderHook(() => useDiscussionDraft({ scope, address: newAddress }));
        expect(kept.getCurrent().text).toBe('My own unsent words');
        await kept.unmount();
    });
});
