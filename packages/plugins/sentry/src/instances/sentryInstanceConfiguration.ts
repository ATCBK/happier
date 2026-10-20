/**
 * The strict source-private configured-instance codecs (`SENTRY.md` §2.4).
 *
 * Two carriers, deliberately disjoint:
 *
 * - the **configuration token** holds only what the aggregate must preserve and
 *   never parse: organization id and source-owned project selection. It carries
 *   no deployment origin, because a second origin authority can go stale after
 *   an explicit reconfiguration.
 * - the **`localInstanceKey`** holds exactly the routing/identity pair
 *   `<normalized deploymentOrigin> U+001F <organizationId>`. It is the only place
 *   the expected origin survives, and a malformed key never routes.
 */

import {
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  TriageSourceScopeSelectionV1Schema,
  TriageSourceScopeUnitV1Schema,
  type TriageSourceScopeSelectionV1,
  type TriageSourceScopeUnitV1,
} from '@happier-dev/triage-protocol/v1';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';

import { normalizeSentryOrigin } from '../auth/sentryOrigin.js';
import { isSentryNumericId, type SentryInvokedInstanceV1 } from './sentryCollisionScope.js';

export type SentryInstanceConfigurationV1 = Readonly<{
  v: 1;
  organizationId: string;
  projectScope: TriageSourceScopeSelectionV1;
  projectUnits?: readonly TriageSourceScopeUnitV1[];
  environmentScope: Readonly<{ kind: 'all' }>;
}>;

export type SentryInstanceConfigurationResultV1 =
  | Readonly<{ ok: true; configuration: SentryInstanceConfigurationV1 }>
  | Readonly<{ ok: false }>;

export type SentryLocalInstanceKeyResultV1 =
  | Readonly<{ ok: true; instance: SentryInvokedInstanceV1 }>
  | Readonly<{ ok: false }>;

const REJECTED = Object.freeze({ ok: false as const });
const SentryInstanceConfigurationV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1), organizationId: defineProtocolString(),
  projectScope: defineProtocolUnion([
    TriageSourceScopeSelectionV1Schema,
    defineProtocolObject({ kind: defineProtocolLiteral('allAccessible') }, { policy: 'closed' }),
  ]),
  projectUnits: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
  environmentScope: defineProtocolObject({ kind: defineProtocolLiteral('all') }, { policy: 'closed' }),
}, { policy: 'closed' });
const storedConfiguration = createProtocolStoredReadSchema(SentryInstanceConfigurationV1Schema);

function normalizeConfiguration(
  value: ReturnType<typeof storedConfiguration.parse>,
): SentryInstanceConfigurationV1 | null {
  if (!isSentryNumericId(value.organizationId)) return null;
  const projectScope = value.projectScope.kind === 'allAccessible'
    ? { kind: 'all' as const } : value.projectScope;
  if (projectScope.kind === 'selected' && !projectScope.unitIds.every(isSentryNumericId)) return null;
  let projectUnits: readonly TriageSourceScopeUnitV1[] | undefined;
  if (projectScope.kind === 'selected' && value.projectUnits !== undefined) {
    const selectedIds = new Set(projectScope.unitIds);
    const byId = new Map<string, TriageSourceScopeUnitV1>();
    for (const unit of value.projectUnits) {
      if (!selectedIds.has(unit.id)) continue;
      // Entry identity remains organization-wide; projects have no distinct collisionScope join.
      byId.set(unit.id, {
        id: unit.id, label: unit.label,
        ...(unit.secondaryText === undefined ? {} : { secondaryText: unit.secondaryText }),
      });
    }
    projectUnits = [...byId.values()];
  }
  return {
    v: 1, organizationId: value.organizationId, projectScope,
    environmentScope: { kind: 'all' },
    ...(projectUnits === undefined ? {} : { projectUnits }),
  };
}

export function encodeSentryInstanceConfiguration(
  configuration: Omit<SentryInstanceConfigurationV1, 'projectScope'> & Readonly<{
    projectScope: SentryInstanceConfigurationV1['projectScope'] | Readonly<{ kind: 'allAccessible' }>;
  }>,
): string {
  const normalized = normalizeConfiguration(SentryInstanceConfigurationV1Schema.parse(configuration));
  if (normalized === null) throw new Error('A Sentry configuration requires immutable numeric organization and project ids.');
  const token = JSON.stringify(normalized);
  if (new TextEncoder().encode(token).byteLength > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    throw new Error('The Sentry instance configuration exceeds the bounded token size.');
  }
  return token;
}

export function decodeSentryInstanceConfiguration(
  token: string,
): SentryInstanceConfigurationResultV1 {
  if (new TextEncoder().encode(token).byteLength > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return REJECTED;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return REJECTED;
  }
  const result = storedConfiguration.safeParse(parsed);
  if (!result.success) return REJECTED;
  const configuration = normalizeConfiguration(result.data);
  if (configuration === null) return REJECTED;
  return Object.freeze({
    ok: true as const,
    configuration: Object.freeze(configuration),
  });
}

export function encodeSentryLocalInstanceKey(instance: SentryInvokedInstanceV1): string {
  const normalized = normalizeSentryOrigin(instance.deploymentOrigin);
  if (!normalized.ok || normalized.origin !== instance.deploymentOrigin) {
    throw new Error('A Sentry localInstanceKey requires an already-normalized canonical origin.');
  }
  if (!isSentryNumericId(instance.organizationId)) {
    throw new Error('A Sentry localInstanceKey requires the numeric organization id.');
  }
  return `${normalized.origin}${SENTRY_SCOPE_SEPARATOR}${instance.organizationId}`;
}

export function decodeSentryLocalInstanceKey(key: string): SentryLocalInstanceKeyResultV1 {
  const parts = key.split(SENTRY_SCOPE_SEPARATOR);
  if (parts.length !== 2) return REJECTED;
  const [rawOrigin = '', organizationId = ''] = parts;
  const normalized = normalizeSentryOrigin(rawOrigin);
  if (!normalized.ok || normalized.origin !== rawOrigin) return REJECTED;
  if (!isSentryNumericId(organizationId)) return REJECTED;
  return Object.freeze({
    ok: true as const,
    instance: Object.freeze({ deploymentOrigin: normalized.origin, organizationId }),
  });
}
