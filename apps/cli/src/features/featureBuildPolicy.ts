import { evaluateFeatureBuildPolicy } from '@happier-dev/protocol/features/buildPolicy';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { resolveEmbeddedFeaturePolicyEnv, resolveFeatureBuildPolicyFromEnvOrEmbedded } from '@happier-dev/protocol/features/embeddedFeaturePolicy';
import type { FeatureBuildPolicyEvaluation, FeatureId } from '@happier-dev/protocol';

export function readCliFeatureBuildPolicyInputs(env: ProcessEnvInput) {
  const embeddedEnv = resolveEmbeddedFeaturePolicyEnv(
    env.HAPPIER_FEATURE_POLICY_ENV ?? env.HAPPIER_EMBEDDED_POLICY_ENV,
  );
  return {
    embeddedEnv: embeddedEnv ?? undefined,
    allowRaw: env.HAPPIER_BUILD_FEATURES_ALLOW,
    denyRaw: env.HAPPIER_BUILD_FEATURES_DENY,
  };
}

export function getCliFeatureBuildPolicyDecision(featureId: FeatureId, env: ProcessEnvInput): FeatureBuildPolicyEvaluation {
  const policy = resolveFeatureBuildPolicyFromEnvOrEmbedded(readCliFeatureBuildPolicyInputs(env));

  return evaluateFeatureBuildPolicy(policy, featureId);
}
