import { describe, expect, it } from 'vitest';
import { resolveSessionForkVisualReferenceTargetV1 } from './forkVisualCopies.js';

describe('fork visual reference target', () => {
    it('uses established Home equivalence for a portable copy and another device profile, preserving exact Session and Item identity', () => {
        const reference = { address: { serverId: 'second-device-profile', sessionId: 'parent' }, itemId: 'graph' };
        const childAddress = { serverId: 'second-device-profile', sessionId: 'child' };
        const copies = [{ originServerId: 'srv_home_a', originSessionId: 'parent', originItemId: 'graph',
            status: 'copied' as const, itemId: 'child-graph' }];
        const scopes: Readonly<Record<string, string>> = { 'second-device-profile': 'srv_home_a', srv_home_a: 'srv_home_a',
            'foreign-profile': 'srv_home_b', srv_home_b: 'srv_home_b' };
        const input = { reference, childAddress, copies, resolveServerScopeId: (id: string) => scopes[id] ?? null };
        expect(resolveSessionForkVisualReferenceTargetV1(input)).toEqual({ status: 'copied', address: childAddress, itemId: 'child-graph' });
        for (const serverId of ['foreign-profile', 'unknown-profile']) {
            expect(resolveSessionForkVisualReferenceTargetV1({ ...input,
                reference: { ...reference, address: { ...reference.address, serverId } },
            })).toEqual({ status: 'not_copied' });
            expect(resolveSessionForkVisualReferenceTargetV1({ ...input,
                childAddress: { ...childAddress, serverId },
            })).toEqual({ status: 'not_copied' });
        }
        expect(resolveSessionForkVisualReferenceTargetV1({ ...input,
            reference: { ...reference, address: { ...reference.address, sessionId: 'another-parent' } },
        })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ ...input,
            reference: { ...reference, itemId: 'another-graph' },
        })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ ...input, resolveServerScopeId: undefined })).toEqual({ status: 'not_copied' });
    });
    it('resolves only the exact original Home/Session/Item to child-owned content without a parent fallback', () => {
        const reference = { address: { serverId: 'home', sessionId: 'parent' }, itemId: 'graph' };
        const childAddress = { serverId: 'home', sessionId: 'child' };
        const copies = [{ originServerId: 'home', originSessionId: 'parent', originItemId: 'graph', status: 'copied' as const, itemId: 'child-graph' }];
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies })).toEqual({ status: 'copied', address: childAddress, itemId: 'child-graph' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference: { ...reference, address: { ...reference.address, serverId: 'other' } }, childAddress, copies })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies: [{ ...copies[0]!, status: 'not_copied' }] })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies: [] })).toEqual({ status: 'not_copied' });
    });
});
