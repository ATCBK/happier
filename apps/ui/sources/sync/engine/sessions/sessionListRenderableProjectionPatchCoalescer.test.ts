import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { applySessionListRenderablePatch } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import { createSessionListRenderableProjectionPatchCoalescer } from './sessionListRenderableProjectionPatchCoalescer';

function renderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
    };
}

describe('createSessionListRenderableProjectionPatchCoalescer', () => {
    it('keeps an admitted request settlement when older public patches share its queued batch', () => {
        vi.useFakeTimers();
        const address = { serverId: 'server-a', sessionId: 'session-1' };
        let current: SessionListRenderableSession = { ...renderable(address.sessionId), hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false, pendingRequestObservedAt: 100 };
        type Patch = Partial<Omit<SessionListRenderableSession, 'id'>>;
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<Patch>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: () => current,
            buildPatch: ({ payload }) => payload,
            applyPatches: patches => {
                for (const { patch } of patches) current = applySessionListRenderablePatch(current, patch);
            },
        });
        coalescer.enqueue(address, { agentStateVersion: 3, hasPendingPermissionRequests: false,
            pendingRequestObservedAt: null }, { deferLeadingPatch: true });
        coalescer.enqueue(address, { agentStateVersion: 2, hasPendingPermissionRequests: true,
            pendingRequestObservedAt: 100 });
        coalescer.flushAll();
        expect(current).toMatchObject({ agentStateVersion: 3, hasPendingPermissionRequests: false,
            pendingRequestObservedAt: null });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('clears immediate-only leading-window state when a session id is dropped', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const applied: Array<{ address: SessionAddress; patch: Readonly<{ updatedAt?: number }> }> = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 1_000, maxBatchSize: 10 }),
            readRenderable: (address) => renderable(address.sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches) => {
                applied.push(...patches);
            },
        });

        const address = { serverId: 'server-a', sessionId: 'session-1' };
        coalescer.enqueue(address, 2, { forceImmediate: true });
        expect(applied.map((entry) => entry.patch.updatedAt)).toEqual([2]);

        coalescer.dropAddresses([address]);
        coalescer.enqueue(address, 3);

        expect(applied.map((entry) => entry.patch.updatedAt)).toEqual([2, 3]);
    });

    it('drops coalesced patches that leave the renderable unchanged after all entries are applied', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const address = { serverId: 'server-a', sessionId: 'session-1' };
        const renderables = new Map<string, SessionListRenderableSession>([
            [sessionAddressKey(address), renderable('session-1')],
        ]);
        const applyPatches = vi.fn((patches: Array<{
            address: SessionAddress;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>) => {
            for (const { address: target, patch } of patches) {
                const key = sessionAddressKey(target);
                const previous = renderables.get(key);
                if (!previous) continue;
                renderables.set(key, { ...previous, ...patch, id: previous.id });
            }
        });
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<boolean>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (target) => renderables.get(sessionAddressKey(target)),
            buildPatch: ({ payload }) => ({ thinking: payload }),
            applyPatches,
        });

        coalescer.enqueue(address, true, { deferLeadingPatch: true });
        coalescer.enqueue(address, false);
        vi.advanceTimersByTime(100);

        expect(applyPatches).not.toHaveBeenCalled();
        expect(renderables.get(sessionAddressKey(address))).toEqual(renderable('session-1'));
    });

    it('keeps matching session ids from different Homes in separate queued batches', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const homeA = { serverId: 'server-a', sessionId: 'session-1' };
        const homeB = { serverId: 'server-b', sessionId: 'session-1' };
        const renderables = new Map<string, SessionListRenderableSession>([
            [sessionAddressKey(homeA), renderable('session-1')],
            [sessionAddressKey(homeB), renderable('session-1')],
        ]);
        const applied: Array<{ address: SessionAddress; patch: Readonly<{ updatedAt?: number }> }> = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (address) => renderables.get(sessionAddressKey(address)),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches) => applied.push(...patches),
        });

        coalescer.enqueue(homeA, 2, { deferLeadingPatch: true });
        coalescer.enqueue(homeB, 3, { deferLeadingPatch: true });
        vi.advanceTimersByTime(100);

        expect(applied).toEqual([
            { address: homeA, patch: expect.objectContaining({ updatedAt: 2 }) },
            { address: homeB, patch: expect.objectContaining({ updatedAt: 3 }) },
        ]);
    });
});
