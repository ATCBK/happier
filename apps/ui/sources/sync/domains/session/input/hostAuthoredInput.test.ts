import { describe, expect, it } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { isHostAuthoredInputMeta, readHostFollowInputMeta } from './hostAuthoredInput';

describe('host input identity', () => {
    const follow = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
        original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
        event: { kind: 'finished' } });
    const meta = { happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
        happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
            permission: {}, followDeliveryV1: follow } };

    it('recognizes pending Follow from the separate Home admission projection before settlement', () => {
        expect(isHostAuthoredInputMeta(meta, follow)).toBe(true);
        expect(readHostFollowInputMeta(meta, follow)).toEqual(follow);
    });

    it('does not trust a pending request or a host-looking field inside authored metadata', () => {
        expect(isHostAuthoredInputMeta({ ...meta, hostFollowInput: follow })).toBe(false);
        expect(readHostFollowInputMeta(meta)).toBeNull();
    });

    it('preserves settled host recognition without requiring the pending projection', () => {
        const { happierInputRequestV1: request, ...rest } = meta;
        const settled = { ...rest, happierInputAuthorityV1: { ...request,
            permission: { admittedPermissionCeiling: 'default' } } };
        expect(isHostAuthoredInputMeta(settled)).toBe(true);
        expect(readHostFollowInputMeta(settled)).toEqual(follow);
    });
});
