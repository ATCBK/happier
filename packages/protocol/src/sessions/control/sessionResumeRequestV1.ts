import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { BackendTargetRefV2Schema, normalizeBackendTargetRefV2InputToV2, type BackendTargetRefV2Input } from '../../backends/targets/backendTargetRefV2.js';
import { SpawnSessionExecutionAuthorizationSchema, SpawnSessionTerminalSchema } from '../spawnSession.js';
import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import { SESSION_PERMISSION_MODES } from '../metadata/sessionPermissionModes.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { SessionAttachMetadataIdentityPolicySchema } from '../attach/metadataIdentityPolicy.js';
import { SessionAuthoringValueV1Schema } from '../authoring/index.js';
import { SessionInitialGoalRequestV1Schema } from '../work/state/sessionWorkStateRpc.js';
import type { ProtocolJsonValue } from '../../plugins/actions/protocolComposableSchema.js';

/** Resume launch intent only. Home admission and requester custody are host-private. */
export const SessionResumeRequestV1Schema = lazyZodSchema(() => z.object({
    type: z.literal('resume-session'),
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    agentTarget: AgentExecutionTargetV1Schema.optional(),
    backendTarget: z.preprocess((input: BackendTargetRefV2Input) => normalizeBackendTargetRefV2InputToV2(input), BackendTargetRefV2Schema).optional(),
    resume: z.string().min(1).optional(),
    runtimeDescriptorV1: z.preprocess((input: ProtocolJsonValue) => input, RuntimeDescriptorV1Schema).optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    terminal: SpawnSessionTerminalSchema.optional(),
    connectedServices: z.preprocess((input: ProtocolJsonValue) => input, SessionAuthoringValueV1Schema.shape.connectedServices).optional(),
    connectedServicesUpdatedAt: z.number().optional(),
    transcriptStorage: z.enum(['direct', 'persisted']).optional(),
    attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
    permissionMode: z.enum(SESSION_PERMISSION_MODES).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    modelSelection: SessionModelSelectionV1Schema.optional(),
    accountSettingsVersionHint: z.number().int().nonnegative().optional(),
    initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
    executionAuthorization: SpawnSessionExecutionAuthorizationSchema.optional(),
    approvedNewDirectoryCreation: z.boolean().optional(),
    initialGoal: z.preprocess((input: ProtocolJsonValue) => input, SessionInitialGoalRequestV1Schema).optional(),
    spawnNonce: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
    if (!value.agentTarget && !value.backendTarget) context.addIssue({
        code: 'custom', path: ['agentTarget'], message: 'agentTarget or configured backendTarget is required',
    });
}));

export type SessionResumeRequestV1 = z.infer<typeof SessionResumeRequestV1Schema>;
