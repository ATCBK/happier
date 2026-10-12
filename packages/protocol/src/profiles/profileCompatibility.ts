import type { AIBackendProfile } from './backendProfileSchema.js';
import {
  buildBackendTargetKey,
  BackendTargetRefSchema,
} from '../backends/targets/backendTargetRef.js';
import {
  readBackendTargetKeyV2,
} from '../backends/targets/backendTargetRefV2.js';

export function isProfileCompatibleWithBackendTarget(
  profile: Pick<AIBackendProfile, 'compatibilityByTargetKey' | 'compatibility' | 'isBuiltIn'>,
  targetInput: unknown,
): boolean {
  const parsedTarget = BackendTargetRefSchema.safeParse(targetInput);
  if (!parsedTarget.success) return false;
  const target = parsedTarget.data;
  const targetKey = readBackendTargetKeyV2(target);
  if (targetKey === null) return false;
  const explicitByTargetKey = profile.compatibilityByTargetKey?.[targetKey];
  if (typeof explicitByTargetKey === 'boolean') return explicitByTargetKey;
  const legacyExplicitByTargetKey = profile.compatibilityByTargetKey?.[buildBackendTargetKey(target)];
  if (typeof legacyExplicitByTargetKey === 'boolean') return legacyExplicitByTargetKey;

  if (target.kind === 'builtInAgent') {
    const explicitLegacy = profile.compatibility?.[target.agentId];
    if (typeof explicitLegacy === 'boolean') return explicitLegacy;
  }

  return profile.isBuiltIn ? false : true;
}

export function isProfileCompatibleWithAgent(
  profile: Pick<AIBackendProfile, 'compatibilityByTargetKey' | 'compatibility' | 'isBuiltIn'>,
  agentId: string,
): boolean {
  return isProfileCompatibleWithBackendTarget(profile, { kind: 'builtInAgent', agentId });
}
