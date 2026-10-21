import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from "@happier-dev/session-core/raw";

import { createWorkspaceMutationIngestion } from './workspaceMutationIngestion';

function toolCallMessage(toolName: string, toolInput: unknown): NormalizedMessage {
    return {
        id: `msg-${toolName}`,
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [
            {
                type: 'tool-call',
                id: `tool-${toolName}`,
                name: toolName,
                input: toolInput as any,
                description: null,
                uuid: `uuid-${toolName}`,
                parentUUID: null,
            },
        ],
    };
}

describe('createWorkspaceMutationIngestion', () => {
    it('uses the existing unknown-path refresh for a committed result without an Action root', () => {
        const invalidateKnownMutation = vi.fn();
        const invalidateUnknownMutation = vi.fn();
        let flush: (() => void) | undefined;
        const ingestion = createWorkspaceMutationIngestion({
            debounceMs: 100, minUnknownOnlyIntervalMs: 1500, now: () => 1000,
            setTimer: fn => { flush = fn; return 1; }, clearTimer() {},
            invalidateKnownMutation, invalidateUnknownMutation,
        });
        ingestion.ingest('session', [{
            id: 'result', localId: null, createdAt: 20, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'apply', is_error: false, uuid: 'uuid', parentUUID: null,
                content: { structuredContent: { ok: true, results: [{ path: 'other-root.ts', status: 'replaced' }] } } }],
        }], 'home');
        flush?.();
        expect(invalidateKnownMutation).not.toHaveBeenCalled();
        expect(invalidateUnknownMutation).toHaveBeenCalledWith('session', 'home');
    });

    it('routes known mutations to invalidateKnownMutation and unknown-only to invalidateUnknownMutation', () => {
        const invalidateKnownMutation = vi.fn();
        const invalidateUnknownMutation = vi.fn();
        let nextTimerId = 1;
        let pendingTimers: Array<Readonly<{ id: number; fn: () => void }>> = [];

        function flushNextTimer() {
            const nextTimer = pendingTimers.shift();
            nextTimer?.fn();
        }

        const ingestion = createWorkspaceMutationIngestion({
            debounceMs: 100,
            minUnknownOnlyIntervalMs: 1500,
            now: () => 1_000,
            setTimer: (fn) => {
                const id = nextTimerId++;
                pendingTimers.push({ id, fn });
                return id;
            },
            clearTimer: (handle) => {
                pendingTimers = pendingTimers.filter((timer) => timer.id !== handle);
            },
            invalidateKnownMutation,
            invalidateUnknownMutation,
        });

        ingestion.ingest('s1', [toolCallMessage('file-edit', { filePath: 'a.ts' })]);
        flushNextTimer();

        expect(invalidateKnownMutation).toHaveBeenCalledTimes(1);
        expect(invalidateKnownMutation).toHaveBeenCalledWith('s1', ['a.ts'], null);
        expect(invalidateUnknownMutation).not.toHaveBeenCalled();

        ingestion.ingest('s1', [toolCallMessage('bash', { command: 'echo hi' })]);
        flushNextTimer();

        expect(invalidateUnknownMutation).toHaveBeenCalledTimes(1);
    });

    it('keeps the same Session id on two Homes as two pending mutation scopes', () => {
        const invalidateKnownMutation = vi.fn();
        const invalidateUnknownMutation = vi.fn();
        const timers: Array<() => void> = [];
        const flushAllTimers = () => {
            const pending = timers.splice(0, timers.length);
            for (const fn of pending) fn();
        };
        const ingestion = createWorkspaceMutationIngestion({
            debounceMs: 10,
            minUnknownOnlyIntervalMs: 1000,
            now: () => 0,
            setTimer: (fn) => { timers.push(fn); return timers.length; },
            clearTimer: () => {},
            invalidateKnownMutation,
            invalidateUnknownMutation,
        });

        ingestion.ingest('s1', [toolCallMessage('file-edit', { filePath: 'a.ts' })], 'home-a');
        ingestion.ingest('s1', [toolCallMessage('file-edit', { filePath: 'b.ts' })], 'home-b');
        flushAllTimers();

        expect(invalidateKnownMutation.mock.calls).toEqual([
            ['s1', ['a.ts'], 'home-a'],
            ['s1', ['b.ts'], 'home-b'],
        ]);
    });
});
