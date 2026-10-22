import { describe, expect, it } from 'vitest';
import { applyReducedMessages, type Message, type OrderedTranscript } from '../index.js';

function message(id: string, seq: number, text = id): Message {
    return { kind: 'agent-text', id, seq, createdAt: seq, localId: null, text };
}

describe('ordered transcript', () => {
    it('retains unchanged rows and order references and returns the previous transcript for no-op output', () => {
        const first = message('first', 1);
        const previous: OrderedTranscript = { messageIdsOldestFirst: ['first'], messagesById: { first } };
        expect(applyReducedMessages(previous, [])).toBe(previous);
        expect(applyReducedMessages(previous, [first])).toBe(previous);
        const appended = applyReducedMessages(previous, [message('next', 2)]);
        expect(appended.messageIdsOldestFirst).toEqual(['first', 'next']);
        expect(appended.messagesById.first).toBe(first);
        expect(appended.messagesById).not.toBe(previous.messagesById);
        expect(previous.messagesById).toEqual({ first });
        const next = appended.messagesById.next;
        const revised = applyReducedMessages(appended, [message('next', 2, 'revised')]);
        expect(revised.messageIdsOldestFirst).toBe(appended.messageIdsOldestFirst);
        expect(revised.messagesById).not.toBe(appended.messagesById);
        expect(appended.messagesById.next).toBe(next);
        expect(appended.messagesById.next?.kind === 'agent-text' && appended.messagesById.next.text).toBe('next');
        expect(revised.messagesById.first).toBe(first);
        expect(revised.messagesById.next?.kind === 'agent-text' && revised.messagesById.next.text).toBe('revised');
    });

    it('merges older pages and repositions rows when durable ordering arrives', () => {
        const previous: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        const initial = applyReducedMessages(previous, [message('tail', 4), message('middle', 2)]);
        const revised = applyReducedMessages(initial, [message('first', 1), message('middle', 5)]);
        expect(revised.messageIdsOldestFirst).toEqual(['first', 'tail', 'middle']);
        expect(Object.keys(revised.messagesById)).toHaveLength(3);
    });

    it('keeps retained snapshots enumerable and unchanged through repeated row revisions', () => {
        const first = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, [
            message('first', 1), message('tail', 2),
        ]);
        let current = first;
        for (let revision = 0; revision < 1000; revision++) {
            current = applyReducedMessages(current, [message('tail', 2, String(revision))]);
        }
        expect(first.messagesById.tail).toMatchObject({ text: 'tail' });
        expect(current.messagesById.tail).toMatchObject({ text: '999' });
        expect(current.messageIdsOldestFirst).toBe(first.messageIdsOldestFirst);
        expect(Object.keys(current.messagesById)).toEqual(['first', 'tail']);
        expect({ ...current.messagesById }).toEqual({ first: first.messagesById.first, tail: current.messagesById.tail });
        expect(JSON.parse(JSON.stringify(current.messagesById))).toEqual({ ...current.messagesById });
    });

    it('retains distinct keys with colliding hashes and normal Record enumeration order', () => {
        // These distinct ids collide under the record's FNV-1a hash. Updates
        // must still address exact ids, never the hash alone.
        const ids = ['costarring', 'liquid', '10', '2', '4294967295'];
        const first = applyReducedMessages({ messageIdsOldestFirst: [], messagesById: {} }, ids.map((id, index) => message(id, index)));
        const revised = applyReducedMessages(first, [message('costarring', 0, 'changed')]);
        expect(revised.messagesById.costarring).toMatchObject({text: 'changed'});
        expect(revised.messagesById.liquid).toBe(first.messagesById.liquid);
        expect(first.messagesById.costarring).toMatchObject({text: 'costarring'});
        expect(Object.keys(revised.messagesById)).toEqual(['2', '10', 'costarring', 'liquid', '4294967295']);
        expect(Object.prototype.hasOwnProperty.call(revised.messagesById, 'liquid')).toBe(true);
    });
});
