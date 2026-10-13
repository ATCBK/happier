import { parsePluginManifest, type ParsedPluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

import { EmailTransportsContributionProtocolV1 } from '../../v1/index.js';

export type EmailTransportContributionV1 = Readonly<{
  target: Readonly<{ pluginId: string; pointId: string }>;
  protocol: Readonly<{ id: string; version: number }>;
  descriptor?: unknown;
  operations: Readonly<Record<string, string>>;
  surfaces?: unknown;
}>;

export type EmailTransportContributionConformanceV1 = Readonly<{
  manifest: ParsedPluginManifest;
  contributions: readonly EmailTransportContributionV1[];
}>;

export type EmailTransportContributionConformanceResultV1 =
  | Readonly<{ ok: true; value: EmailTransportContributionConformanceV1 }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const protocol = EmailTransportsContributionProtocolV1;
const roleDefinitions = protocol.point().protocols[0]!.operations;

/**
 * Checks one author's declarations against the email transport V1 roles.
 * The SDK owns manifest parsing; host installation and runtime admission stay host-owned.
 */
export function checkEmailTransportContributionV1(manifestInput: unknown): EmailTransportContributionConformanceResultV1 {
  const parsed = parsePluginManifest(manifestInput);
  if (!parsed.ok) return { ok: false, errors: parsed.diagnostics.map(diagnostic =>
    `${diagnostic.path?.join('.') || 'manifest'}: ${diagnostic.message}`) };

  const contributions = parsed.manifest.contributes.targetedPluginContributions.filter(contribution =>
    contribution.target.pluginId === 'happier.channel.email' && contribution.target.pointId === 'transports');
  if (contributions.length === 0) return { ok: false, errors: [
    'Email transport V1 conformance requires a transport contribution.',
  ] };
  const errors: string[] = [];
  const actions = new Map(parsed.manifest.contributes.actions.map(action => [action.id, action]));
  for (const contribution of contributions) {
    if (contribution.protocol.id !== protocol.id || contribution.protocol.version !== protocol.version) {
      errors.push(`Email transport contribution must declare protocol '${protocol.id}' version ${protocol.version}.`);
    }
    if (contribution.descriptor !== undefined) errors.push('Email transport V1 has no descriptor.');
    if (contribution.surfaces !== undefined) errors.push('Email transport V1 has no renderer surfaces.');
    for (const role of Object.keys(contribution.operations)) {
      if (!Object.hasOwn(protocol.operations, role)) errors.push(`Email transport V1 has no '${role}' role.`);
    }
    for (const role of Object.keys(protocol.operations) as Array<keyof typeof protocol.operations>) {
      const actionId = contribution.operations[role];
      if (actionId === undefined) {
        if (roleDefinitions[role]!.required) errors.push(`Email transport V1 requires the '${role}' role binding.`);
        continue;
      }
      const action = actions.get(actionId);
      if (!action) {
        errors.push(`Email transport role '${role}' references undeclared Action '${actionId}'.`);
        continue;
      }
      const expected = protocol.operations[role].declaration;
      if (!expected.surfaces.every(surface => action.surfaces.includes(surface))) {
        errors.push(`Email transport role '${role}' has an incompatible Action surface.`);
      }
      if (action.dangerLevel !== expected.dangerLevel) errors.push(`Email transport role '${role}' has an incompatible danger level.`);
      if (!pluginJsonValuesEqual(action.inputSchema, expected.input.schema.jsonSchema)) {
        errors.push(`Email transport role '${role}' has an incompatible input schema.`);
      }
      if (!pluginJsonValuesEqual(action.resultSchema, expected.resultSchema.jsonSchema)) {
        errors.push(`Email transport role '${role}' has an incompatible result schema.`);
      }
    }
  }
  return errors.length === 0
    ? { ok: true, value: { manifest: parsed.manifest, contributions } }
    : { ok: false, errors };
}

export function assertEmailTransportContributionV1(manifest: unknown): EmailTransportContributionConformanceV1 {
  const result = checkEmailTransportContributionV1(manifest);
  if (!result.ok) throw new TypeError(`Email transport V1 contribution is not conformant: ${result.errors.join(' ')}`);
  return result.value;
}
