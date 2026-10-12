import { describe, expect, it } from 'vitest';

import { readExecutionRunRequestedAction } from './executionRunRequestedAction';

describe('readExecutionRunRequestedAction', () => {
    it('preserves a stored non-default action with an unknown retired field', () => {
        expect(readExecutionRunRequestedAction({ v: 1, kind: 'steer_now', retired: true }))
            .toEqual({ v: 1, kind: 'steer_now' });
    });
    it('preserves the canonical Pending requested action', () => {
        expect(readExecutionRunRequestedAction({ v: 1, kind: 'steer_now' })).toEqual({
            v: 1,
            kind: 'steer_now',
        });
    });

    it('does not approximate obsolete delivery policy', () => {
        expect(readExecutionRunRequestedAction('prompt')).toEqual({ v: 1, kind: 'enqueue' });
        expect(readExecutionRunRequestedAction('steer_if_supported')).toEqual({ v: 1, kind: 'enqueue' });
        expect(readExecutionRunRequestedAction('interrupt')).toEqual({ v: 1, kind: 'enqueue' });
    });

    it('defaults malformed or absent storage values', () => {
        expect(readExecutionRunRequestedAction(null)).toEqual({ v: 1, kind: 'enqueue' });
        expect(readExecutionRunRequestedAction('cancel_and_send')).toEqual({ v: 1, kind: 'enqueue' });
    });
});
