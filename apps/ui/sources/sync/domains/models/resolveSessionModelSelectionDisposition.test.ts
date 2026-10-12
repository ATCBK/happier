import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@happier-dev/session-core/state';

import { resolveSessionModelSelectionDisposition } from './resolveSessionModelSelectionDisposition';
import { resolveSessionComposerSendDestination } from '@/sync/domains/session/input/resolveSessionComposerSendDestination';

function appliedConnectedClaudeMetadata() {
    return MetadataSchema.parse({
        path: '/tmp/project', host: 'localhost', permissionMode: 'plan',
        connectedServices: {
            v: 2,
            bindingsByServiceId: {
                'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        },
        modelSelectionIntentV1: {
            v: 1, updatedAt: 11,
            selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
        },
        sessionModelsV1: {
            v: 1, agentId: 'claude', updatedAt: 12, currentModelId: 'claude-haiku-4-5',
            availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku 4.5' }],
            activeSelectionV1: {
                v: 1, source: 'runtime_apply',
                selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' },
                runner: { pid: 42, processStartTimeMs: 10 },
            },
        },
    });
}

describe('resolveSessionModelSelectionDisposition', () => {
    it('keeps a connected Claude follow-up on its existing route after Plan → Build when runner observation is unavailable', () => {
        const metadata = appliedConnectedClaudeMetadata();
        for (const permissionMode of ['plan', 'default'] as const) {
            const disposition = resolveSessionModelSelectionDisposition({
                agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
                metadata: { ...metadata, permissionMode }, sessionActive: true,
                currentRunnerProcessIdentity: null,
            });
            // A previously applied choice is not a new route choice. Missing
            // observation must not fabricate current runtime/context authority.
            expect(disposition).toMatchObject({
                activeSelection: null, contextSelection: null,
                reportedSelectionStatus: 'last_reported', selectionTransitionPending: false,
            });
            expect(resolveSessionComposerSendDestination({
                route: 'sessionAgent', armedContinuation: null, armedContinuationLocalId: null,
                armedRoute: disposition.selectionTransitionPending ? { turnActive: false } : null,
                machineId: 'machine-1', pendingTransitionOutcome: 'settled',
            })).toEqual({ kind: 'sessionAgent' });
        }
    });

    it('still requires transition admission for a different model or Provider connection without runner observation', () => {
        const metadata = appliedConnectedClaudeMetadata();
        for (const selection of [
            { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-sonnet-4-6' },
            { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc-new', modelId: 'claude-haiku-4-5' },
        ]) {
            expect(resolveSessionModelSelectionDisposition({
                agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
                metadata: { ...metadata, modelSelectionIntentV1: { v: 1, updatedAt: 13, selection } },
                sessionActive: true, currentRunnerProcessIdentity: null,
            }).selectionTransitionPending).toBe(true);
        }
    });

    it('does not use a historical applied selection when the observed runner has been replaced', () => {
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata: appliedConnectedClaudeMetadata(), sessionActive: true,
            currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 20 },
        })).toMatchObject({ activeSelection: null, contextSelection: null, selectionTransitionPending: true });
    });

    it('does not treat an incoherent historical selection as an applied proposal', () => {
        const metadata = appliedConnectedClaudeMetadata();
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata: { ...metadata, sessionModelsV1: { ...metadata.sessionModelsV1!, availableModels: [] } },
            sessionActive: true, currentRunnerProcessIdentity: null,
        }).selectionTransitionPending).toBe(true);
    });

    it('projects exact V2 Team provenance while retaining the Team source', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });
        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: false, currentRunnerProcessIdentity: null,
        }).proposedSelectionV2?.ref).toEqual({
            source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
            expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
        });
    });

    it('keeps a durable V2 Team proposal pending for an active Session after UI remount', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: true, currentRunnerProcessIdentity: null,
        })).toMatchObject({
            proposedSelectionV2: {
                ref: { source: 'team_resource', modelId: 'team-model' },
            },
            activeSelection: null,
            selectionTransitionPending: true,
        });
    });

    it('stops presenting a Team restart after the exact runner was started from the durable intent', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project', host: 'localhost',
            modelSelectionIntentV2: {
                v: 2, updatedAt: 11,
                ref: {
                    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
                },
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude', agentTargetKey: 'agent:happier.agent.claude/claude', metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: { pid: 42, processStartTimeMs: 12 },
        })).toMatchObject({
            proposedSelectionV2: {
                ref: { source: 'team_resource', modelId: 'team-model' },
            },
            selectionTransitionPending: false,
        });
    });

    it('keeps an active proposal pending until exact runner authority proves it active', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            modelSelectionIntentV1: {
                v: 1,
                updatedAt: 11,
                selection: {
                    agentTargetKey: 'agent:happier.agent.claude/claude',
                    providerConnectionId: null,
                    modelId: 'proposed-model',
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 10,
                currentModelId: 'last-reported-model',
                availableModels: [],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata,
            sessionActive: true,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            activeSelection: null,
            selectionTransitionPending: true,
            reportedSelection: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: null,
                modelId: 'last-reported-model',
            },
            reportedSelectionStatus: 'last_reported',
            contextSelection: null,
        });
    });

    it('does not project an incoherent Provider binding as last-reported model truth', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            providerBindingV1: {
                v: 1,
                connectionId: 'pc_provider',
                contributionKey: 'plugin.openrouter/openrouter',
                connectionRevision: 3,
                protocol: 'openai-responses',
                materialization: 'engineConfig',
                adapterBindingKey: 'openrouter',
                compatibilityFingerprint: 'compatibility-v1',
                bindingSecurityFingerprint: 'incoherent-fingerprint',
                displaySnapshot: {
                    providerName: 'OpenRouter',
                    connectionName: 'Work',
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
                model: {
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                },
                runtimeBindingBasis: {
                    v: 1,
                    deployment: { kind: 'external' },
                    agentTargetKey: 'agent:happier.agent.claude/claude',
                    connectionId: 'pc_provider',
                    contributionKey: 'plugin.openrouter/openrouter',
                    endpoint: {
                        endpointTemplateId: 'responses',
                        normalizedUrl: 'https://provider.example/v1',
                        protocol: 'openai-responses',
                        publicHeaders: { 'x-provider': 'openrouter' },
                    },
                    runtimeCredentialTransport: {
                        id: 'runtime-bearer',
                        protocols: ['openai-responses'],
                        uses: ['runtime'],
                        destination: {
                            kind: 'httpHeader',
                            name: 'authorization',
                            format: 'bearer',
                        },
                    },
                    prepared: {
                        v: 1,
                        materialization: 'engineConfig',
                        adapterBindingKey: 'openrouter',
                    },
                    adapterVersion: 1,
                    credentialAuthorization: {
                        connectionSecurityFingerprint: 'connection-security-v1',
                        grantFingerprint: 'grant-v1',
                        selectedSecretBindingId: 'binding-v1',
                        selectedSecretRecordFingerprint: 'record-v1',
                    },
                    agentSupport: {
                        acceptsProtocols: ['openai-responses'],
                        required: { streaming: true },
                        credentialSupport: {
                            supportsNoAuth: false,
                            apiKeyTransports: [{
                                protocol: 'openai-responses',
                                destination: {
                                    kind: 'httpHeader',
                                    names: ['authorization'],
                                    formats: ['bearer'],
                                },
                            }],
                        },
                        authIsolation: {
                            suppressConnectedServiceIds: [],
                            ownedEnvKeys: ['OPENAI_API_KEY'],
                        },
                        materialization: 'engineConfig',
                        applyPolicy: 'live',
                        supportsFreeformModelIds: true,
                    },
                },
            },
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'provider-last-reported',
                availableModels: [{
                    id: 'provider-last-reported',
                    name: 'Provider last reported',
                    contextWindowTokens: 400_000,
                }],
            },
        });

        expect(resolveSessionModelSelectionDisposition({
            agentId: 'claude',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            metadata,
            sessionActive: false,
            currentRunnerProcessIdentity: null,
        })).toMatchObject({
            reportedSelection: null,
            reportedSelectionStatus: null,
            contextSelection: null,
        });
    });
});
