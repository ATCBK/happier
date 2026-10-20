import { describe, expect, it } from 'vitest';
import { buildAskSelectionDrafts, buildAskSelectionQuote, resolveAskSelectionDestination } from './askSelectionModel';
import { computeLineContentHash } from '@/utils/text/lineContentHash';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { ReviewCommentDraftMessageV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';

describe('Ask selection context', () => {
    it('anchors a dirty editor selection against saved lines and keeps the exact selection snapshot', () => {
        const [draft] = buildAskSelectionDrafts({ filePath: 'src/app.ts', source: 'file',
            text: 'new unsaved line\nfirst\nchanged second\nlast', savedText: 'first\nsecond\nlast',
            ranges: [{ startLine: 2, endLine: 3, text: 'irst\nchanged sec' }] });
        expect(draft).toMatchObject({ body: '', includeInPrompt: true,
            anchor: { kind: 'range', startLine: 1, endLine: 2, startLineHash: computeLineContentHash('first'), endLineHash: computeLineContentHash('second') },
            snapshot: { selectedLines: ['irst', 'changed sec'] } });
        expect(ReviewCommentDraftMessageV1Schema.parse(draft)).toEqual(draft);
    });

    it('uses the caret line and dedupes repeated ranges without changing an existing draft identity', () => {
        const input = { filePath: 'a.ts', source: 'file' as const, text: 'one\ntwo', savedText: 'one\ntwo',
            ranges: [{ startLine: 2, endLine: 2, text: '' }, { startLine: 2, endLine: 2, text: '' }] };
        const first = buildAskSelectionDrafts(input);
        expect(first).toHaveLength(1);
        expect(first[0]?.snapshot.selectedLines).toEqual(['two']);
        expect(buildAskSelectionDrafts({ ...input, existingDrafts: first })[0]?.id).toBe(first[0]?.id);
    });

    it('keeps unanchored code containing fences as one editable quote', () => {
        const text = 'before\n```ts\nconst answer = 42;\n```\nafter';
        const quote = buildAskSelectionQuote({ text, filePath: 'a.ts', startLine: 4, endLine: 8 });
        expect(quote).toBe(`a.ts:4-8\n\n\`\`\`\`\n${text}\n\`\`\`\``);
    });

    it.each([['', 1], ['one\n', 2]] as const)('can ask about the current blank editor line in %j', (text, line) => {
        const [draft] = buildAskSelectionDrafts({ filePath: 'empty.ts', source: 'file', text, savedText: text,
            ranges: [{ startLine: line, endLine: line, text: '' }] });
        expect(draft).toMatchObject({ anchor: { kind: 'range', startLine: line, endLine: line }, snapshot: { selectedLines: [''] } });
        expect(ReviewCommentDraftMessageV1Schema.parse(draft)).toEqual(draft);
    });

    it('dedupes an after-side diff range and keeps a comment the person already wrote', () => {
        const text = '@@ -1,2 +1,2 @@\n one\n-old\n+new';
        const input = { filePath: 'a.ts', source: 'diff' as const, text,
            lines: buildCodeLinesFromUnifiedDiff({ unifiedDiff: text }), ranges: [{ startLine: 2, endLine: 2, text: 'new' }] };
        const [first] = buildAskSelectionDrafts(input);
        if (!first) throw new Error('Expected the diff selection');
        const [again] = buildAskSelectionDrafts({ ...input, existingDrafts: [{ ...first, body: 'My question' }] });
        expect(again).toMatchObject({ id: first.id, body: 'My question', anchor: { side: 'after', startLine: 2 } });
    });

    it('routes session Ask to its composer and a project Ask to the chosen target with detached fallback', () => {
        expect(resolveAskSelectionDestination({ sessionId: 's1', target: 'session', detachedSupported: true })).toBe('composer');
        expect(resolveAskSelectionDestination({ sessionId: null, target: 'detached_run', detachedSupported: true })).toBe('side_run');
        expect(resolveAskSelectionDestination({ sessionId: null, target: 'session', detachedSupported: true })).toBe('new_session');
        expect(resolveAskSelectionDestination({ sessionId: null, target: 'detached_run', detachedSupported: false })).toBe('new_session');
        expect(resolveAskSelectionDestination({ sessionId: 's1', target: 'session', detachedSupported: true, sideRun: true })).toBe('side_run');
        expect(resolveAskSelectionDestination({ sessionId: 's1', target: 'session', detachedSupported: false, sideRun: true })).toBe('new_session');
    });
});
