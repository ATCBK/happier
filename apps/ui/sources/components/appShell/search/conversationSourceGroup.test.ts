import { describe, expect, it } from 'vitest';

import type { ConversationSearchResult } from '@/sync/domains/search/searchConversations';

import { conversationSourceHasGroup, orderConversationSourceGroups } from './conversationSourceGroup';

const source = (sourceKey: string) => ({ machineId: 'm1', agentId: 'claude', sourceKey, source: {} as never, contentSearch: true });
const sourceOf = (agentId: string, sourceKey: string) => ({ machineId: 'm1', agentId, sourceKey, source: {} as never, contentSearch: true });
const standardHit = (agentId: string, sourceKey: string) => ({ mode: 'standard' as const, machineId: 'm1', agentId, sourceKey,
    candidate: { remoteSessionId: `${agentId}-hit`, updatedAtMs: 1, match: { snippet: 'a harbor note', sourceItemId: 'i1' } } });
const result = (patch: Partial<ConversationSearchResult>): ConversationSearchResult => ({ hits: [], machines: [], ...patch });

describe('conversation source groups', () => {
    it('draws a group for a source that has a next page even with no rows', () => {
        expect(conversationSourceHasGroup(result({ continuations: [{ machineId: 'm1', sourceKey: 'a', cursor: 'next' }] }), source('a'), 'q')).toBe(true);
    });

    // F4 (r11): a row-less source's footer drawn above another source's hits read as that source's heading.
    it('draws sources with rows first and a source with only a next page last, each hit under its own source', () => {
        const codex = sourceOf('codex', 'a');
        const claude = sourceOf('claude', 'b');
        const reply = result({
            hits: [standardHit('claude', 'b')] as never,
            continuations: [{ machineId: 'm1', sourceKey: 'a', cursor: 'next' }],
        });
        expect(orderConversationSourceGroups(reply, [codex, claude], 'harbor').map(value => value.sourceKey)).toEqual(['b', 'a']);
        expect(orderConversationSourceGroups(reply, [claude, codex], 'harbor').map(value => value.sourceKey)).toEqual(['b', 'a']);
    });

    it('keeps the incoming order within sources that both have rows, and when nothing has rows', () => {
        const [a, b] = [sourceOf('claude', 'a'), sourceOf('claude', 'b')];
        const rows = result({ hits: [standardHit('claude', 'a'), standardHit('claude', 'b')] as never });
        expect(orderConversationSourceGroups(rows, [b, a], 'harbor').map(value => value.sourceKey)).toEqual(['b', 'a']);
        expect(orderConversationSourceGroups(null, [b, a], 'harbor').map(value => value.sourceKey)).toEqual(['b', 'a']);
    });

    it('draws nothing for a source with no rows and no next page, and never borrows another source\'s cursor', () => {
        expect(conversationSourceHasGroup(result({}), source('a'), 'q')).toBe(false);
        expect(conversationSourceHasGroup(result({ continuations: [{ machineId: 'm1', sourceKey: 'b', cursor: 'next' }] }), source('a'), 'q')).toBe(false);
        expect(conversationSourceHasGroup(null, source('a'), 'q')).toBe(false);
    });
});
