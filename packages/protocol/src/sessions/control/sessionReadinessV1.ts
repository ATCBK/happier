import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineSpawnReadinessV1Schema } from '../../machines/machineSpawnReadinessV1.js';
import { MachineAgentExecutionStateV1Schema } from '../../capabilities/machineAgentInventory.js';
import { MachinesAgentsSignInStartInputSchema } from '../../daemon/agentSignIn.js';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS } from '../../connect/authenticationActionsV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { TeamCredentialResourceReadinessV1Schema } from '../../teams/credentials/readinessV1.js';
import { TeamCredentialResourceRecoveryActionV1Schema } from '../../teams/credentials/resourceV1.js';
import { SessionEffectiveAccessV1Schema } from '../access/sessionEffectiveAccessV1.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { SessionModelSelectionV2Schema } from '../../providers/selection/v2.js';

/** Diagnostic only: unread owner/Provider selection never borrows native sign-in or viewer defaults. */
export function isSessionReadinessNativeSelectionV1(input: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null;
  /** undefined = the canonical Provider owner could not resolve the route. */
  providerConnectionId: string | null | undefined;
}>): boolean {
  const metadata = input.metadata;
  if (!metadata || input.providerConnectionId !== null) return false;
  const bindings = metadata.connectedServices === undefined ? null : ConnectedServiceBindingsV2IngressSchema.safeParse(metadata.connectedServices);
  const model = metadata.modelSelectionIntentV2 === undefined ? null : SessionModelSelectionV2Schema.safeParse(metadata.modelSelectionIntentV2);
  return (model === null || model.success && model.data.ref.source === 'native')
    && (bindings === null || bindings.success && Object.values(bindings.data.bindingsByServiceId).every(binding => binding.source === 'native'));
}

/** Existing repair Actions, proposed only by an entitled setup owner. Never executed by a read. */
export const SessionReadinessRepairV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal('machines.agents.signIn.start'), input: MachinesAgentsSignInStartInputSchema }),
  z.strictObject({ actionId: z.literal('connectedServices.authentication.beginReconnect'),
    input: CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS['connectedServices.authentication.beginReconnect'] }),
]));
export type SessionReadinessRepairV1 = z.infer<typeof SessionReadinessRepairV1Schema>;

/** Carries the credential owner's result. There is no second credential health decision here. */
export const SessionCredentialReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('not_required') }),
  z.strictObject({ kind: z.literal('unknown') }),
  z.strictObject({ kind: z.literal('team'), resourceId: z.string().check(z.minLength(1)),
    teamId: z.string().check(z.minLength(1)), readiness: z.nullable(TeamCredentialResourceReadinessV1Schema),
    recoveryAction: z.nullable(TeamCredentialResourceRecoveryActionV1Schema) }),
  z.strictObject({ kind: z.literal('personal'), purpose: QualifiedConnectedAccountPurposeV1Schema,
    usable: z.nullable(z.boolean()), repair: z.nullable(SessionReadinessRepairV1Schema) }),
]));
export type SessionCredentialReadinessV1 = z.infer<typeof SessionCredentialReadinessV1Schema>;

export const SessionReadinessAgentV1Schema = lazyZodSchema(() => z.strictObject({
  agentId: z.string().check(z.minLength(1)), definitionId: z.optional(z.string().check(z.minLength(1))),
  state: MachineAgentExecutionStateV1Schema,
  current: z.boolean(), observedAtMs: z.nullable(z.number().check(z.nonnegative())),
  repair: z.nullable(SessionReadinessRepairV1Schema),
}));
export type SessionReadinessAgentV1 = z.infer<typeof SessionReadinessAgentV1Schema>;

const SessionReadinessFactsV1Schema = lazyZodSchema(() => z.strictObject({
  configured: z.boolean(),
  /** Explicitly scopes the claim: conversation readiness never certifies an outward write. */
  operation: z.enum(['conversation', 'credential']),
  machine: z.nullable(MachineSpawnReadinessV1Schema),
  agent: z.nullable(SessionReadinessAgentV1Schema),
  invocation: z.nullable(SessionEffectiveAccessV1Schema),
  credential: SessionCredentialReadinessV1Schema,
}));
export type SessionReadinessFactsV1 = z.infer<typeof SessionReadinessFactsV1Schema>;

export const SessionReadinessV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionReadinessFactsV1Schema.shape, v: z.literal(1),
  status: z.enum(['ready', 'unavailable', 'unknown']),
  cause: z.nullable(z.enum(['configuration', 'machine', 'agent', 'invocation', 'credential'])),
}));
export type SessionReadinessV1 = z.infer<typeof SessionReadinessV1Schema>;

/** Pure diagnostic composition. Actual operations always re-admit at their original owner. */
export function composeSessionReadinessV1(facts: SessionReadinessFactsV1): SessionReadinessV1 {
  const result = (status: SessionReadinessV1['status'], cause: SessionReadinessV1['cause']): SessionReadinessV1 => ({ ...facts, v: 1, status, cause });
  if (!facts.configured) return result('unavailable', 'configuration');
  if (facts.invocation?.capabilities.submitAgentInput === false) return result('unavailable', 'invocation');
  const machine = facts.machine?.status ?? 'unknown';
  if (machine !== 'ready' && machine !== 'unknown' && machine !== 'probing') return result('unavailable', 'machine');
  if (facts.agent?.current && ['needsSignIn', 'notInstalled', 'unsupported'].includes(facts.agent.state)) return result('unavailable', 'agent');
  const credential = facts.credential;
  if (facts.operation === 'credential') {
    if (credential.kind === 'personal' && credential.usable === false) return result('unavailable', 'credential');
    if (credential.kind === 'team' && credential.readiness && credential.readiness.kind !== 'available') return result('unavailable', 'credential');
  }
  if (machine !== 'ready') return result('unknown', 'machine');
  if (!facts.agent?.current || facts.agent.state !== 'ready') return result('unknown', 'agent');
  if (!facts.invocation) return result('unknown', 'invocation');
  if (facts.operation === 'credential' && (credential.kind === 'not_required' || credential.kind === 'unknown'
    || (credential.kind === 'personal' && credential.usable === null) || (credential.kind === 'team' && !credential.readiness))) return result('unknown', 'credential');
  return result('ready', null);
}
