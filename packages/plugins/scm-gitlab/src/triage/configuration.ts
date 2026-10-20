/**
 * The source-private configured-instance token.
 *
 * GitLab's configured deployment origin is the source-native instance scope and
 * therefore travels as `localInstanceKey`; the source contract forbids a token
 * that duplicates a configured origin, so it is deliberately absent here. What
 * remains is the project selection in a versioned envelope: this source mints it, this source is
 * the only decoder. Retained tokens ignore retired fields; another version,
 * malformed known facts or an oversize string remain rejected.
 *
 * Retained empty V1 envelopes mean All; new writes use the shared selection.
 * The token can never carry a credential,
 * a header, an account ref, a filesystem path, or a target timestamp.
 */

import {
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  TriageSourceScopeSelectionV1Schema,
  TriageSourceScopeUnitV1Schema,
  type TriageSourceScopeSelectionV1,
  type TriageSourceScopeUnitV1,
  type TriageSourceInstanceConfigurationV1,
} from '@happier-dev/triage-protocol/v1';
import { createProtocolStoredReadSchema, defineProtocolArray, defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

const GitlabConfigurationRecordV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1), selection: TriageSourceScopeSelectionV1Schema.optional(),
  units: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
}, { policy: 'closed' });
const storedConfiguration = createProtocolStoredReadSchema(GitlabConfigurationRecordV1Schema);

/** The closed source-owned configured-instance record. */
export type GitlabConfigurationRecord = Readonly<{ v: 1; selection: TriageSourceScopeSelectionV1; units?: readonly TriageSourceScopeUnitV1[] }>;

export const GITLAB_CONFIGURATION_RECORD_V1: GitlabConfigurationRecord = Object.freeze({
  v: 1, selection: { kind: 'all' },
} satisfies GitlabConfigurationRecord);

export function encodeGitlabConfiguration(
  record: GitlabConfigurationRecord | Readonly<{ v: 1 }>,
): TriageSourceInstanceConfigurationV1 | null {
  const configuration = { v: 1 as const, token: JSON.stringify(record) };
  const normalized = decodeGitlabConfiguration(configuration);
  if (normalized === null) return null;
  return { v: 1, token: JSON.stringify(normalized) };
}

/**
 * Returns `null` for every token this source cannot prove it owns. The caller
 * turns that into a typed `unsupportedContract` failure; it never falls back to
 * a default configuration, because a default would let one instance's scan run
 * under another instance's intent.
 */
export function decodeGitlabConfiguration(
  configuration: TriageSourceInstanceConfigurationV1,
): GitlabConfigurationRecord | null {
  if (configuration.v !== 1) return null;
  if (new TextEncoder().encode(configuration.token).length
    > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration.token);
  } catch {
    return null;
  }
  const read = storedConfiguration.safeParse(parsed);
  if (!read.success) return null;
  const selection = read.data.selection ?? { kind: 'all' as const };
  if (selection.kind === 'all') return GITLAB_CONFIGURATION_RECORD_V1;
  if (!selection.unitIds.every((id) => /^[1-9][0-9]*$/u.test(id))) return null;
  return { v: 1, selection, ...(read.data.units === undefined ? {} : {
    units: read.data.units.filter((unit) => selection.unitIds.includes(unit.id)),
  }) };
}
