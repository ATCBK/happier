import { describe, expect, it } from 'vitest';

import { DiscussionMessageContentV1Schema, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';

import {
    buildDiscussionAccountMentionPayload,
    buildDiscussionContent,
    buildDiscussionContentFromPendingText,
    buildDiscussionModelSlotMentionPayload,
    resolveDiscussionCreationTitle,
} from './discussionComposerDocument';

function mention(payload: Readonly<{ kind: string; ref: string; label: string }>, start = 0): ComposerStructuredInputMention {
    const tokenText = formatInlineReferenceTokenV1(payload);
    return { ...payload, tokenText, start, end: start + tokenText.length };
}

describe('discussion composer document', () => {
    it('submits inline Account and Session ranges directly as unchanged participant parts', () => {
        const account = mention(buildDiscussionAccountMentionPayload('same-id', 'Alex'));
        const session = mention({ kind: 'happier.session', ref: 'session:same-id', label: 'Alex' }, account.end + 1);
        const text = `${account.tokenText} ${session.tokenText}`;
        const content = buildDiscussionContentFromPendingText({ previousText: text, pendingText: `Ask ${text}`, mentions: [account, session] });
        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Ask ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'same-id' } },
            { t: 'text', text: ' ' },
            { t: 'mention', participant: { kind: 'session', sessionId: 'same-id' } },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content).mentionedAccountIds).toEqual(['same-id']);
        expect(readDiscussionMentionedParticipantIdsV1(buildDiscussionContent(session.tokenText, [{ ...session, start: 0, end: session.tokenText.length }]))
            .mentionedAccountIds).toEqual([]);
    });

    it('keeps an unstarted slot inert until its send-time owner resolves a Session', () => {
        const slot = mention(buildDiscussionModelSlotMentionPayload('saved-model-slot', 'Model'));
        expect(() => buildDiscussionContent(slot.tokenText, [slot])).toThrow('discussion_participant_start_required');
        expect(buildDiscussionContent(slot.tokenText, [slot], new Map([['saved-model-slot', 'started-session']]))).toEqual({ v: 1, parts: [
            { t: 'mention', participant: { kind: 'session', sessionId: 'started-session' } },
        ] });
    });

    it('does not infer identity from pasted inline tokens, a mismatched scheme or another kind', () => {
        const selected = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        for (const mentions of [[], [{ ...selected, ref: 'session:account-a' }], [{ ...selected, kind: 'partner.account' }]]) {
            expect(buildDiscussionContent(selected.tokenText, mentions)).toEqual({ v: 1, parts: [{ t: 'text', text: selected.tokenText }] });
        }
    });

    it('drops only the edited reference when reconciling a pending input', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        const session = mention({ kind: 'happier.session', ref: 'session:session-b', label: 'Bob' }, account.end + 5);
        const text = `${account.tokenText} and ${session.tokenText}`;
        const edited = account.tokenText.replace('Alex', 'Alexa');
        const content = buildDiscussionContentFromPendingText({ previousText: text, pendingText: `${edited} and ${session.tokenText}`, mentions: [account, session] });
        expect(content).toEqual({ v: 1, parts: [
            { t: 'text', text: `${edited} and ` },
            { t: 'mention', participant: { kind: 'session', sessionId: 'session-b' } },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content).mentionedAccountIds).toEqual([]);
    });

    it('preserves reference identity beside adjacent text and normalizes authored text to NFC', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'), 6);
        expect(buildDiscussionContent(`Cafe\u0301 ${account.tokenText}!`, [account])).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Café ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
            { t: 'text', text: '!' },
        ] });
    });

    it('requires an exact current token range before authoring a mention part', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        expect(buildDiscussionContent(account.tokenText, [{ ...account, end: account.end - 1 }])).toEqual({ v: 1, parts: [{ t: 'text', text: account.tokenText }] });
    });

    it('uses an explicit title or the first nonempty non-reference line', () => {
        const account = mention(buildDiscussionAccountMentionPayload('account-a', 'Alex'));
        expect(resolveDiscussionCreationTitle({ title: '  Release review  ', text: '' })).toBe('Release review');
        expect(resolveDiscussionCreationTitle({ title: '', text: `\n${account.tokenText} First line\nSecond line`, mentions: [{ ...account, start: 1, end: account.end + 1 }] })).toBe('First line');
        expect(resolveDiscussionCreationTitle({ title: '', text: account.tokenText, mentions: [account] })).toBeNull();
    });
});
