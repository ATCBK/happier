import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkspaceSyncSourceExecutionV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { MachineInstallationProofV1Schema } from '../../machines/identity/installationIdentity.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';

/** The installed receiver binds its actual birth request to the original reviewed public child. */
export const DiscussionModelSessionCreationProofV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineAdmission: SocketRpcMachineAdmissionContextV1Schema,
  sourceExecution: WorkspaceSyncSourceExecutionV1Schema,
  proof: MachineInstallationProofV1Schema,
}).check(z.refine(value => value.sourceExecution.externalActionExecution.authorization.binding.actionId === 'discussion.second_opinion.start'
  && value.sourceExecution.externalActionExecution.effectActionId === 'session.spawn_new'
  && value.sourceExecution.originalActionEnvelope !== undefined
  && value.sourceExecution.method === `${value.machineAdmission.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`)));
export type DiscussionModelSessionCreationProofV1 = z.infer<typeof DiscussionModelSessionCreationProofV1Schema>;

/** Host-private callback; credentials and installation keys never enter Session spawn data. */
export type SessionCreationAuthorizationV1 = Readonly<{
  token: string;
  prepareRequestProof?: (body: Readonly<Record<string, unknown>>) => Promise<DiscussionModelSessionCreationProofV1>;
}>;

export function buildDiscussionModelSessionCreationProofPayloadV1(input: Readonly<{
  machineAdmission: DiscussionModelSessionCreationProofV1['machineAdmission'];
  sourceExecution: DiscussionModelSessionCreationProofV1['sourceExecution'];
  body: Readonly<Record<string, unknown>>;
}>) {
  return {
    version: 1 as const, machineId: input.machineAdmission.machineId,
    installationId: input.machineAdmission.installationId, accountId: input.machineAdmission.custodianAccountId,
    sessionCreation: {
      sourceExecutionDigest: computeCanonicalDomainSeparatedDigest('happier-session-creation-source-v1', [createCanonicalJsonSigningInput(input.sourceExecution)]),
      requestBodyDigest: computeCanonicalDomainSeparatedDigest('happier-session-creation-body-v1', [createCanonicalJsonSigningInput(input.body)]),
    },
  };
}
