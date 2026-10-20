import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

// Stage-zero dependency installation also consumes this policy, before the
// validation runner's package imports can be resolved on a cold worker.
export function resolveRemoteValidationPreparationEnv(env, validationKind, defaultBuildMode = validationKind === 'runtime' ? 'source-dev' : 'strict') {
  return { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? defaultBuildMode, env,
  }), ...(validationKind === 'typecheck' || validationKind === 'runtime' ? { HAPPIER_WORKSPACE_CAPTURE_INPUTS: '1' } : {}) };
}
