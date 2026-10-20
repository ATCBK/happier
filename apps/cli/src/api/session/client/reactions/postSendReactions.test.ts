import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type {
    AgentState,
    Metadata,
} from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { logger } from '@/ui/logger';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';

import {
    applyAcpPostSendReactions,
} from './postSendReactions';

function createReactionPort(overrides?: Partial<Metadata>) {
    let metadata: Metadata = createTestMetadata(overrides);
    let agentState: AgentState = {};
    const publish = vi.fn().mockResolvedValue(undefined);
    const requestStore = new AgentStateRequestStore({ logPrefix: '[Reaction test]', target: {
        scopeId: 'session-1', readState: () => agentState,
        updateState: updater => { agentState = updater(agentState); },
    } });

    return {
        port: {
            sessionId: 'session-1',
            updateMetadata: (updater: (current: Metadata) => Metadata) => {
                metadata = updater(metadata);
            },
            getAgentStateRequestStore: () => requestStore,
            getMetadataSnapshot: () => metadata,
            usageObservationPublisher: { publish },
        },
        getMetadata: () => metadata,
        getAgentState: () => agentState,
        publish,
    };
}

describe('postSendReactions', () => {
    it('does not infer usage runtime mode from opaque Session metadata', () => {
        const source = readFileSync(new URL('./providers/applyAcpPostSendReactions.ts', import.meta.url), 'utf8');

        expect(source).toContain('backendMode: null');
        expect(source).not.toMatch(/readSessionMetadataRuntimeDescriptor/);
        expect(source).not.toMatch(/@happier-dev\/plugins-opencode/);
        expect(source).not.toMatch(/provider\s*={2,3}\s*['"]opencode['"]/);
        expect(source).not.toMatch(/switch\s*\(\s*params\.provider\s*\)/);
        expect(source).not.toMatch(/case\s+['"](codex|opencode|pi)['"]/);
    });

    it('redacts token_count usage publication errors before logging', async () => {
        const { port } = createReactionPort();
        port.usageObservationPublisher.publish = vi.fn(async () => {
            throw new Error(
                'token_count failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/usage?token=secret Authorization: Bearer USAGE_SECRET',
            );
        });
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

        try {
            applyAcpPostSendReactions(port, {
                provider: 'opencode',
                normalizedBody: {
                    type: 'token_count',
                    tokens: { total: 9, input: 4, output: 5 },
                },
                localId: 'local-1',
                createdAt: 1,
                provenance: { kind: 'non_dependent', source: 'external' },
            });

            await vi.waitFor(() => {
                expect(warnSpy.mock.calls.some(([message]) =>
                    message === '[SOCKET] Failed to publish token_count usage observation (non-fatal)'
                )).toBe(true);
            });
            const [, logged] = warnSpy.mock.calls.find(([message]) =>
                message === '[SOCKET] Failed to publish token_count usage observation (non-fatal)'
            ) ?? [];
            expect(logged).toEqual(expect.objectContaining({
                name: 'Error',
                message: 'token_count failed for https://api.example.test/v1/usage Authorization: <redacted>',
            }));
            expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
            expect(JSON.stringify(logged)).not.toContain('token=secret');
            expect(JSON.stringify(logged)).not.toContain('USAGE_SECRET');
            expect(JSON.stringify(logged)).not.toContain('stack');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('mirrors ACP permission requests into agent state', () => {
        const { port, getAgentState, publish } = createReactionPort();

        applyAcpPostSendReactions(port, {
            provider: 'claude',
            normalizedBody: {
                type: 'permission-request',
                permissionId: 'perm-1',
                toolName: 'write',
                description: 'write',
                options: {
                    input: {
                        filepath: '/tmp/outside.txt',
                    },
                },
            },
            localId: 'local-1',
            createdAt: 1,
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        expect(getAgentState().requests?.['perm-1']).toMatchObject({
            tool: 'write',
            source: 'claude',
            arguments: {
                input: {
                    filepath: '/tmp/outside.txt',
                },
            },
        });
        expect(publish).not.toHaveBeenCalled();
    });

    it('ignores normal ACP lifecycle markers in post-send reactions', () => {
        const { port, getAgentState, getMetadata } = createReactionPort();

        applyAcpPostSendReactions(port, {
            provider: 'codex',
            normalizedBody: {
                type: 'task_complete',
                id: 'turn-1',
            },
            localId: 'local-1',
            createdAt: 1,
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        expect(getAgentState()).toEqual({});
        expect(getMetadata()).toEqual(createTestMetadata());
    });

    it('publishes token_count usage without guessing a runtime mode', async () => {
        const { port, publish } = createReactionPort({ opencodeBackendMode: 'server' });

        applyAcpPostSendReactions(port, {
            provider: 'opencode',
            normalizedBody: {
                type: 'token_count',
                tokens: { total: 9, input: 4, output: 5 },
                key: 'opencode-message:1',
                source: 'opencode-message-updated',
                scope: 'turn_delta',
            },
            localId: 'local-1',
            createdAt: 1,
            provenance: { kind: 'non_dependent', source: 'external' },
        });

        await vi.waitFor(() => {
            expect(publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: 'session-1',
                    backendMode: null,
                    externalKey: 'opencode-message:1',
                    observation: expect.objectContaining({
                        provider: 'opencode',
                    }),
                }),
            );
        });
    });

});
