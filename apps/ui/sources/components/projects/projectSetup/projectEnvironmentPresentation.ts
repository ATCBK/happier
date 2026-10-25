import type {
  ProjectCommandSourceV1,
  ProjectManifestV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { t } from '@/text';

import { describeProjectEnvironment, describeProjectTool } from './projectScriptPresentation';

/**
 * Plan 24 copy for a Project's native environment (Mise, Devbox, devenv, Flox, Nix flake). The one
 * place that decides which words an environment state uses; surfaces pass the selected environment's
 * name and read the sentence back. The host environment has no state of its own to describe.
 */

/** "devenv", "Nix flake": the selected native environment as people read it; null for the host. */
export function nativeEnvironmentNameFor(
  manifest: Pick<ProjectManifestV1, 'environment'> | null | undefined,
): string | null {
  const environment = manifest?.environment;
  return environment && environment.kind !== 'host'
    ? describeProjectEnvironment(environment).title
    : null;
}

/** The plan's phrases are sentence fragments or sentences; the refusal reads as two sentences. */
const sentence = (text: string) => (text.endsWith('.') ? text : `${text}.`);

/** The producer's typed refusals while preparing the native environment (never an evaluation failure of a script). */
const PREPARATION_FAILED = new Set([
  'native_environment_failed',
  'native_environment_invalid',
  'native_environment_termination_incomplete',
]);

/**
 * What a Run that never reached the native environment says, or null when the code is not an
 * environment-preparation refusal (the row then keeps its generic refusal). Failure never falls back to
 * the host, and the sentence says so.
 */
export function describeNativeEnvironmentRefusal(
  code: string,
  environmentName: string | null,
): string | null {
  if (!environmentName) return null;
  const reason =
    code === 'native_tool_unavailable'
      ? t('projects.scripts.environment.unavailable', { tool: environmentName })
      : PREPARATION_FAILED.has(code)
        ? t('projects.scripts.environment.failed')
        : null;
  return reason
    ? [reason, t('projects.scripts.environment.noFallback')].map(sentence).join(' ')
    : null;
}

/**
 * The sentence a failed Run reads as. A missing tool is the environment's only when the script runs
 * inside it as a literal command or through the environment's own tool; another native source's
 * missing runner keeps the generic refusal rather than blaming the wrong tool.
 */
export function describeScriptEnvironmentRefusal(
  code: string | null,
  manifest: Pick<ProjectManifestV1, 'environment'>,
  source: ProjectCommandSourceV1,
): string | null {
  const name = nativeEnvironmentNameFor(manifest);
  if (!code || !name) return null;
  const inside = source.kind === 'command' || (source.kind === 'native' && describeProjectTool(source.tool) === name);
  return inside ? describeNativeEnvironmentRefusal(code, name) : null;
}
