import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { IrohEndpointDescriptorV1Schema } from '../../connectivity/iroh/endpointDescriptorV1.js';
import { RunnerCredentialSelectionBindingV1Schema } from '../../ephemeralRunner/review.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { TeamCredentialUsageLimitMetricV1Schema } from './usageV1.js';

export {
  createRunnerBrokerReadinessSigningInputV1,
  IrohRunnerBrokerReadinessHandshakeV1Schema,
  RunnerBrokerReadinessFactsV1Schema,
  RunnerBrokerReadinessRequestV1Schema,
  signRunnerBrokerReadinessRequestV1,
  verifyRunnerBrokerReadinessRequestV1,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';
export type {
  IrohRunnerBrokerReadinessHandshakeV1,
  RunnerBrokerReadinessFactsV1,
  RunnerBrokerReadinessRequestV1,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';
import {
  RunnerBrokerReadinessFactsV1Schema,
  type RunnerBrokerReadinessRequestV1 as RunnerBrokerReadinessRequest,
} from '../../ephemeralRunner/brokerReadinessRequestV1.js';

export const RunnerBrokerProviderPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  identity: asProtocolZod(PluginContributionIdentityV1Schema),
  definitionRevision: z.literal(1),
}));

/** Safe, content-free readiness reported by the credential-resource owner. */
export const TeamCredentialResourceReadinessV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({ kind: z.literal('resource_corrupt') }),
  z.strictObject({ kind: z.literal('resource_unavailable') }),
  z.strictObject({ kind: z.literal('source_unavailable') }),
  z.strictObject({
    kind: z.literal('broker_unavailable'),
    // Diagnostic only: omitted unless all evaluated candidates report the same refusal.
    reason: z.optional(z.enum(['application_unavailable', 'model_unavailable'])),
  }),
  z.strictObject({ kind: z.literal('update_required') }),
  z.strictObject({ kind: z.literal('policy_denied') }),
  z.strictObject({
    kind: z.literal('limit_reached'),
    // The one metric vocabulary: the limit owner decides with it, the catalog
    // read copies the denial's metric into this readiness, and the picker
    // labels it. A second spelling here makes the whole catalog entry throw.
    metric: TeamCredentialUsageLimitMetricV1Schema,
    resetsAtUtc: z.string().check(z.iso.datetime()),
  }),
]));
export type TeamCredentialResourceReadinessV1 = z.infer<typeof TeamCredentialResourceReadinessV1Schema>;

const RunnerBrokerReadinessResponseBindingV1Schema = lazyZodSchema(() => z.omit(RunnerBrokerReadinessFactsV1Schema, {
  v: true,
  kind: true,
}));

export const RunnerBrokerReadinessResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  binding: RunnerBrokerReadinessResponseBindingV1Schema,
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  readiness: TeamCredentialResourceReadinessV1Schema,
}).check(z.superRefine((value, context) => {
  const selection = value.credentialSelectionBinding;
  if (
    selection.resourceId !== value.binding.resourceId
    || selection.brokerMachineId !== value.binding.target.machineId
    || selection.application.agentTargetKey !== value.binding.agentTargetKey
    || selection.application.protocol !== value.binding.protocol
  ) context.addIssue({
    code: "custom",
    path: ['credentialSelectionBinding'],
    message: 'Reviewed credential selection must match readiness facts',
  });
})));
export type RunnerBrokerReadinessResponseV1 = z.infer<typeof RunnerBrokerReadinessResponseV1Schema>;

/**
 * Keeps every readiness consumer bound to the exact signed request facts. The
 * response schema already binds the reviewed credential selection to these
 * facts; this check prevents a valid response for another activation or
 * transport endpoint from being substituted by an intermediary.
 */
export function doesRunnerBrokerReadinessResponseMatchRequestV1(
  request: RunnerBrokerReadinessRequest,
  response: RunnerBrokerReadinessResponseV1,
): boolean {
  const binding = response.binding;
  return binding.homeServerIdentityId === request.homeServerIdentityId
    && binding.activationId === request.activationId
    && binding.launchManifestCommitment === request.launchManifestCommitment
    && binding.resourceId === request.resourceId
    && binding.agentTargetKey === request.agentTargetKey
    && binding.modelId === request.modelId
    && binding.protocol === request.protocol
    && binding.initiator.installationId === request.initiator.installationId
    && binding.initiator.endpointId === request.initiator.endpointId
    && binding.target.machineId === request.target.machineId
    && binding.target.endpointId === request.target.endpointId;
}

/** Exact content-free broker projection returned only to the proof-bound endpoint. */
export const RunnerBrokerReadinessProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  target: IrohEndpointDescriptorV1Schema,
  provider: z.nullable(RunnerBrokerProviderPresentationV1Schema),
  readiness: TeamCredentialResourceReadinessV1Schema,
}));
export type RunnerBrokerReadinessProjectionV1 = z.infer<typeof RunnerBrokerReadinessProjectionV1Schema>;
