import { describe, expect, it, vi } from 'vitest';
import {
    MENTION_KIND_V1,
    buildComposerReferenceMentionPayloadV1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ComposerAttachmentDispatchResolver } from '@/agent/runtime/runPermissionModePromptLoop';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;

describe('ExecutionRunHostBridge retained structured input', () => {
    it('uses incumbent catalogs and resolvers with the exact Pending input identity', async () => {
        const runtimeLifetime = new AbortController();
        const delivered = vi.fn(async () => ({ status: 'admitted' as const }));
        const controller = {
            kind: 'backend',
            controllerOccurrenceId: 'pending-structured-occurrence-1',
            backend: {
                interaction: {
                    kind: 'retained_agent_session.v1',
                    capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
                },
                deliverInput: delivered,
                getRuntimeLifetimeSignal: () => runtimeLifetime.signal,
                subscribeMessages: () => () => undefined,
                readResumeSupport: async () => true,
                provisionRuntime: async () => ({ runtimeId: 'provider-session-1' }),
                cancel: async () => undefined,
                dispose: async () => undefined,
            },
            backendSupportsResume: true,
            runtimeId: 'provider-session-1',
            buffer: '',
            sidechainStreamBuffer: '',
            sidechainStreamKey: '',
            streamWriter: null,
            cancelled: false,
            turnCount: 0,
            turnEpoch: 0,
            turnInFlight: false,
            turnCancelReason: null,
            turnCancelEpoch: null,
            admittedLiveInterventions: [],
            admittedLiveInterventionsSignal: null,
            lastMarkerWriteAtMs: 0,
            terminalPromise: Promise.resolve(),
            resolveTerminal: () => undefined,
        } satisfies ExecutionRunBackendController;
        const input = {
            role: 'user',
            content: { type: 'text', text: 'Inspect this context.' },
            localId: 'pending-input-1',
            authorAccountId: 'account-1',
            inputAdmissionReceipt: null,
            pendingProviderAction: 'send',
            meta: {
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [
                        {
                            kind: MENTION_KIND_V1.skill,
                            ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'),
                            token: '$review',
                            start: 0,
                            end: 7,
                        },
                        {
                            ...buildComposerReferenceMentionPayloadV1({
                                reference: { pluginId: 'acme.issues', localId: 'issues' },
                                candidate: { id: 'issue:42', label: 'Issue 42' },
                            }),
                            token: '@issue-42',
                            start: 8,
                            end: 17,
                        },
                    ],
                    composerAttachments: [{
                        v: 1,
                        instanceId: 'review-comment-1',
                        attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
                        key: 'comment-1',
                        value: { reviewId: 'review-1' },
                        presentation: { label: 'Review comment', typeLabel: 'Review comment' },
                    }],
                },
            },
        } satisfies ExecutionRunAdmittedPendingInputV1;
        let consume: ((input: ExecutionRunAdmittedPendingInputV1) => boolean) | null = null;
        let materialized = false;
        let materializeCalls = 0;
        const listSkills = vi.fn(async () => ({
            skills: [{
                name: 'review', displayName: 'Review', path: '/repo/SKILL.md',
                enabled: true, origin: 'codex_native',
            }],
        }));
        const resolveComposerReference = vi.fn(async () => ({
            id: 'issue:42', label: 'Issue 42', context: 'Current issue context.',
        }));
        const resolveComposerAttachment: ComposerAttachmentDispatchResolver = async (request) => ({
            attachments: request.request.attachments.map((attachment) => ({
                instanceId: attachment.instanceId,
                status: 'ready' as const,
                context: 'Current attachment context.',
            })),
        });
        const resolveComposerAttachmentForDispatch = vi.fn(resolveComposerAttachment);
        const manager = new ExecutionRunHostBridge({
            parentProvider: TEST_BACKEND_ID,
            cwd: '/repo',
            sendAcp: async () => undefined,
            sessionInteractionHost: {
                session: {
                    sessionId: 'session-1',
                    getMetadataSnapshot: () => null,
                    updateMetadata: vi.fn(),
                    updateAgentState: vi.fn(),
                    enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
                    bindExecutionRunPendingInput: (binding) => {
                        consume = binding.consume;
                        return {
                            // Missing metadata is an unreadable Session, which blocks Pending drains.
                            getMetadataSnapshot: () => ({}),
                            waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
                            shouldAttemptPendingMaterialization: () => true,
                            reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                            materializeNextPendingMessageSafely: async () => {
                                materializeCalls += 1;
                                if (materialized) return { type: 'no_pending' as const };
                                materialized = true;
                                consume?.(input);
                                return { type: 'materialized' as const, localId: input.localId, seq: null, content: null };
                            },
                            observeProviderInputSettlement: async () => true,
                            readDurableProviderInputAcceptanceV1: async () => 'unknown' as const,
                            dispose: () => undefined,
                        };
                    },
                },
                machineId: 'machine-1',
                permissionHandler: { handleToolCall: vi.fn() },
                listSkills,
                resolveComposerReference,
                resolveComposerAttachmentForDispatch,
            },
        });
        const runs = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
        const controllers = (manager as unknown as { controllers: Map<string, ExecutionRunBackendController> }).controllers;
        runs.set('run-1', {
            runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', sessionId: 'session-1', depth: 0,
            intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
            backendId: TEST_BACKEND_ID, instructions: 'Continue.', permissionMode: 'read_only',
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        });
        controllers.set('run-1', controller);

        const release = (manager as unknown as {
            attachRetainedRunSessionInput(input: {
                runId: string; sidechainId: string; controller: ExecutionRunBackendController;
            }): { release(): void } | null;
        }).attachRetainedRunSessionInput({ runId: 'run-1', sidechainId: 'sidechain-1', controller });
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());

        expect(release).not.toBeNull();
        expect(consume).not.toBeNull();
        expect(materializeCalls).toBeGreaterThan(0);
        expect(listSkills).toHaveBeenCalledOnce();
        expect(resolveComposerReference).toHaveBeenCalledWith({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            candidateId: 'issue:42',
            signal: runtimeLifetime.signal,
        });
        expect(resolveComposerAttachmentForDispatch).toHaveBeenCalledWith({
            sessionId: 'session-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            request: {
                sessionId: 'session-1',
                localId: 'pending-input-1',
                attachments: [{ instanceId: 'review-comment-1', key: 'comment-1', value: { reviewId: 'review-1' } }],
            },
            signal: runtimeLifetime.signal,
        });
        await release?.release();
    });
});
