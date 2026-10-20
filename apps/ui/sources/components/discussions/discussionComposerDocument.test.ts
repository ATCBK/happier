import { describe, expect, it } from 'vitest';

import { DiscussionMessageContentV1Schema, readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';

import {
    buildDiscussionContent,
    buildDiscussionContentFromPendingText,
    discussionComposerMentionsFromSpans,
    discussionMentionSpansFromComposerMentions,
    parseDiscussionMentionSpans,
    reconcileDiscussionMentionSpans,
    resolveDiscussionCreationTitle,
} from './discussionComposerDocument';

describe('discussion composer document', () => {
    it('keeps an unstarted model slot inert through draft edits and refuses to serialize it as a Session', () => {
        const raw = [{ start: 0, end: 6, participantSlotId: 'saved-model-slot' }];
        const spans = parseDiscussionMentionSpans(raw, '@Model');
        expect(spans).toEqual(raw);
        const mentions = discussionComposerMentionsFromSpans('@Model', spans);
        expect(mentions[0]).not.toMatchObject({ kind: 'happier.session' });
        expect(discussionMentionSpansFromComposerMentions(mentions)).toEqual(raw);
        expect(reconcileDiscussionMentionSpans({ previousText: '@Model', nextText: 'Ask @Model', mentions: spans }))
            .toEqual([{ start: 4, end: 10, participantSlotId: 'saved-model-slot' }]);
        expect(() => buildDiscussionContent('@Model', spans)).toThrow();
    });
    it('submits Account and Session mentions through the canonical participant content arm without mixing person attention', () => {
        const mentions = [
            { start: 0, end: 5, accountId: 'same-id' },
            { start: 6, end: 11, sessionId: 'same-id' },
        ];
        const content = buildDiscussionContentFromPendingText({ previousText: '@Alex @Alex', pendingText: 'Ask @Alex @Alex', mentions });
        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({ v: 1, parts: [
            { t: 'text', text: 'Ask ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'same-id' } },
            { t: 'text', text: ' ' },
            { t: 'mention', participant: { kind: 'session', sessionId: 'same-id' } },
        ] });
        expect(readDiscussionMentionedParticipantIdsV1(content).mentionedAccountIds).toEqual(['same-id']);
        expect(readDiscussionMentionedParticipantIdsV1(buildDiscussionContent('@Alex', [
            { start: 0, end: 5, sessionId: 'same-id' },
        ])).mentionedAccountIds).toEqual([]);
        expect(buildDiscussionContentFromPendingText({
            previousText: '@Alex @Alex', pendingText: '@Alex @Alex2', mentions,
        })).toEqual({ v: 1, parts: [
            { t: 'mention', participant: { kind: 'account', accountId: 'same-id' } },
            { t: 'text', text: ' @Alex2' },
        ] });
    });

    it('projects person attention from strict submitted content after a pending edit, never stale draft spans', () => {
        const spans = [{ start: 0, end: 5, accountId: 'account-alex' }];
        expect(readDiscussionMentionedParticipantIdsV1(buildDiscussionContent('@Alex', spans)).mentionedAccountIds).toEqual(['account-alex']);
        const pending = buildDiscussionContentFromPendingText({
            previousText: '@Alex', pendingText: '@Alex2', mentions: spans,
        });
        expect(readDiscussionMentionedParticipantIdsV1(pending).mentionedAccountIds).toEqual([]);
        expect(readDiscussionMentionedParticipantIdsV1(DiscussionMessageContentV1Schema.parse({ v: 1, parts: [
            { t: 'mention', participant: { kind: 'account', accountId: 'account-alex' } },
            { t: 'text', text: ' and ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'account-alex' } },
        ] })).mentionedAccountIds).toEqual(['account-alex']);
    });

    it('round-trips distinct Account and Session identities even when their visible labels match', () => {
        const text = '@Alex @Alex';
        const spans = [
            { start: 0, end: 5, accountId: 'account-alex' },
            { start: 6, end: 11, sessionId: 'session-alex' },
        ];
        const restored = parseDiscussionMentionSpans(spans, text);
        expect(restored).toEqual(spans);
        const mentions = discussionComposerMentionsFromSpans(text, restored);
        expect(mentions[1]).toEqual({
            kind: 'happier.session', ref: 'session:session-alex',
            tokenText: '@Alex', start: 6, end: 11,
        });
        expect(discussionMentionSpansFromComposerMentions(mentions)).toEqual(spans);
        expect(reconcileDiscussionMentionSpans({ previousText: text, nextText: `Ask ${text}`, mentions: restored })).toEqual([
            { start: 4, end: 9, accountId: 'account-alex' },
            { start: 10, end: 15, sessionId: 'session-alex' },
        ]);
    });

    it('rejects forged or ambiguous participant identity in restored draft spans', () => {
        expect(parseDiscussionMentionSpans([
            { start: 0, end: 5, accountId: 'account-a', sessionId: 'session-a' },
            { start: 0, end: 5, sessionId: ' session-spoof ' },
            { start: 0, end: 5, sessionId: 'session-a', authority: true },
        ], '@Alex')).toEqual([]);
    });

    it('keeps the selected later identity when deleting a prefix with a shared token suffix', () => {
        expect(reconcileDiscussionMentionSpans({
            previousText: 'Ask @Alice and @Alex', nextText: 'Ask @Alex',
            mentions: [{ start: 15, end: 20, accountId: 'selected-alex' }],
        })).toEqual([{ start: 4, end: 9, accountId: 'selected-alex' }]);
    });

    it('does not manufacture an address from overlapping restored spans at submission', () => {
        expect(buildDiscussionContentFromPendingText({
            previousText: '@Alex', pendingText: '@Alex',
            mentions: [{ start: 0, end: 5, accountId: 'first' }, { start: 0, end: 5, accountId: 'second' }],
        })).toEqual({ v: 1, parts: [{ t: 'text', text: '@Alex' }] });
    });

    it.each(['x@Alex', '@Alex2', '@Alex_name'])('drops addressing when a boundary edit makes %s ordinary text', (nextText) => {
        expect(buildDiscussionContentFromPendingText({
            previousText: '@Alex', pendingText: nextText,
            mentions: [{ start: 0, end: 5, accountId: 'selected-alex' }],
        })).toEqual({ v: 1, parts: [{ t: 'text', text: nextText }] });
    });

    it('uses a manual title override when present', () => {
        expect(resolveDiscussionCreationTitle({
            title: '  Release review  ',
            text: '\nFirst message',
        })).toBe('Release review');
    });

    it('derives an omitted title from the first nonempty message line without inventing a UI limit', () => {
        const firstLine = 'A deliberately long title remains owned by the protocol request boundary';
        expect(resolveDiscussionCreationTitle({
            title: '   ',
            text: `\n  ${firstLine}  \nSecond line`,
        })).toBe(firstLine);
    });

    it('requires an explicit title when the first message contains only structured mentions', () => {
        expect(resolveDiscussionCreationTitle({
            title: '   ',
            text: '@Alex',
            mentions: [{ start: 0, end: 5, accountId: 'account-a' }],
        })).toBeNull();
    });

    it('carries Account mentions between the one composer and the discussion draft unchanged', () => {
        const text = 'Hi @Alice Ng and @bob!';
        const spans = [
            { start: 3, end: 12, accountId: 'account-a' },
            { start: 17, end: 21, accountId: 'account-b' },
        ];

        const mentions = discussionComposerMentionsFromSpans(text, spans);

        expect(mentions).toEqual([
            { kind: 'happier.account', ref: 'account:account-a', tokenText: '@Alice Ng', start: 3, end: 12 },
            { kind: 'happier.account', ref: 'account:account-b', tokenText: '@bob', start: 17, end: 21 },
        ]);
        expect(discussionMentionSpansFromComposerMentions(mentions)).toEqual(spans);
        expect(buildDiscussionContent(text, discussionMentionSpansFromComposerMentions(mentions)).parts).toEqual([
            { t: 'text', text: 'Hi ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
            { t: 'text', text: ' and ' },
            { t: 'mention', participant: { kind: 'account', accountId: 'account-b' } },
            { t: 'text', text: '!' },
        ]);
    });

    it('never reads an Account out of another mention kind or a malformed Account reference', () => {
        expect(discussionMentionSpansFromComposerMentions([
            { kind: 'happier.file', ref: 'file:account-a', tokenText: '@a', start: 0, end: 2 },
            { kind: 'happier.account', ref: 'session:account-a', tokenText: '@b', start: 3, end: 5 },
            { kind: 'happier.account', ref: 'account: account-spoof ', tokenText: '@c', start: 6, end: 8 },
            { kind: 'happier.session', ref: 'account:account-a', tokenText: '@a', start: 0, end: 2 },
            { kind: 'partner.session', ref: 'session:session-a', tokenText: '@a', start: 0, end: 2 },
        ])).toEqual([]);
    });

    it('preserves and shifts exact mention spans around an ordinary edit', () => {
        const mentions = [
            { start: 3, end: 8, accountId: 'account-a' },
            { start: 13, end: 17, accountId: 'account-b' },
        ] as const;

        expect(reconcileDiscussionMentionSpans({
            previousText: 'Hi @Alex and @Bob!',
            nextText: 'Well, Hi @Alex and @Bob!',
            mentions,
        })).toEqual([
            { start: 9, end: 14, accountId: 'account-a' },
            { start: 19, end: 23, accountId: 'account-b' },
        ]);

        expect(reconcileDiscussionMentionSpans({
            previousText: 'Hi @Alex and @Bob!',
            nextText: 'Hi @Alex and @Bob! Later',
            mentions,
        })).toEqual(mentions);
    });

    it('drops only a mention whose visible token was edited', () => {
        expect(reconcileDiscussionMentionSpans({
            previousText: 'Hi @Alex and @Bob!',
            nextText: 'Hi @Alexa and @Bob!',
            mentions: [
                { start: 3, end: 8, accountId: 'account-a' },
                { start: 13, end: 17, accountId: 'account-b' },
            ],
        })).toEqual([{ start: 14, end: 18, accountId: 'account-b' }]);
    });

    it('builds strict authored content in visible order', () => {
        const content = buildDiscussionContent('Hi @Alex and @Bob!', [
            { start: 3, end: 8, accountId: 'account-a' },
            { start: 13, end: 17, accountId: 'account-b' },
        ]);

        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({
            v: 1,
            parts: [
                { t: 'text', text: 'Hi ' },
                { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
                { t: 'text', text: ' and ' },
                { t: 'mention', participant: { kind: 'account', accountId: 'account-b' } },
                { t: 'text', text: '!' },
            ],
        });
    });

    it('normalizes authored text to the strict Protocol NFC form before transport', () => {
        const content = buildDiscussionContent('Cafe\u0301 @Alex', [
            { start: 6, end: 11, accountId: 'account-a' },
        ]);

        expect(DiscussionMessageContentV1Schema.parse(content)).toEqual({
            v: 1,
            parts: [
                { t: 'text', text: 'Café ' },
                { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
            ],
        });
    });

    it('reconciles structured mentions against the flushed editor text before sending', () => {
        expect(buildDiscussionContentFromPendingText({
            previousText: 'Hi @Alex',
            pendingText: 'Well, Hi @Alex',
            mentions: [{ start: 3, end: 8, accountId: 'account-a' }],
        })).toEqual({
            v: 1,
            parts: [
                { t: 'text', text: 'Well, Hi ' },
                { t: 'mention', participant: { kind: 'account', accountId: 'account-a' } },
            ],
        });
    });

    it('admits only exact, non-overlapping structured mention spans bound to visible mention text', () => {
        expect(parseDiscussionMentionSpans([
            { start: 3, end: 8, accountId: 'account-a' },
            { start: 3, end: 8, accountId: ' account-spoof ' },
            { start: 13, end: 17, accountId: 'account-b', authority: true },
            { start: 13, end: 17, accountId: 'account-b' },
            { start: 99, end: 100, accountId: 'account-outside' },
        ], 'Hi @Alex and @Bob!')).toEqual([
            { start: 3, end: 8, accountId: 'account-a' },
            { start: 13, end: 17, accountId: 'account-b' },
        ]);
        expect(parseDiscussionMentionSpans([
            { start: 3, end: 7, accountId: 'account-a' },
        ], 'Hi Alex')).toEqual([]);
        expect(parseDiscussionMentionSpans([
            { start: 3, end: 8, accountId: 'account-a' },
            { start: 3, end: 8, accountId: 'account-b' },
        ], 'Hi @Alex')).toEqual([]);
    });
});
