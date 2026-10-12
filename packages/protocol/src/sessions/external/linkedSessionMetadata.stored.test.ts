import { describe, expect, it } from 'vitest';

import {
  buildLinkedExternalSessionMetadataV1,
  ExternalHistoryImportV1Schema,
  ExternalSessionFollowIssueV1Schema,
  ExternalSessionFollowStatusV1Schema,
  readExternalHistoryImportV1FromMetadata,
  readExternalSessionFollowIssueV1,
  readExternalSessionFollowPolicyV1,
  readExternalSessionFollowStatusV1,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalHistoryImportV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
} from './linkedSessionMetadata.js';
import { ExternalSessionsSourceSchema } from './sourceCatalog.js';

describe('retained external session metadata readers', () => {
  it('projects retained typed link fields while preserving opaque native and plugin data', () => {
    const link = {
      v: 1 as const, agentId: 'codex', machineId: 'machine-1', remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      qualifiedIdentity: { v: 1 as const, agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
        source: { kind: 'codexHome', contractVersion: 1 as const } },
      followPolicyV1: { v: 1 as const, policy: 'attached_only' as const, updatedAtMs: 10 },
      followStatusV1: { v: 1 as const, status: 'active' as const, updatedAtMs: 10 },
      lastFollowIssueV1: { v: 1 as const, code: 'paused', observedAtMs: 10 },
      runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: { opaqueNativeState: { retired: true } } },
      linkData: { arbitraryNativeData: { retired: true } },
    };
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: link })).toEqual(link);
    const retained = { ...link, retired: true,
      source: { ...link.source, retired: true },
      qualifiedIdentity: { ...link.qualifiedIdentity, retired: true,
        agent: { ...link.qualifiedIdentity.agent, retired: true },
        source: { ...link.qualifiedIdentity.source, retired: true } },
      followPolicyV1: { ...link.followPolicyV1, retired: true },
      followStatusV1: { ...link.followStatusV1, retired: true },
      lastFollowIssueV1: { ...link.lastFollowIssueV1, retired: true },
    };
    // Generic source envelopes are declared bounded native JSON. Declaration
    // admission owns stricter source fields; linked metadata preserves this bag.
    const expected = { ...link, source: retained.source };
    expect(ExternalSessionsSourceSchema.parse(retained.source)).toEqual(retained.source);
    expect(buildLinkedExternalSessionMetadataV1({}, expected)).toEqual({ externalSessionV1: expected });
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: retained })).toEqual(expected);
    expect(resolveLinkedExternalSessionMetadataV1({ externalSessionV1: retained }, 'stored'))
      .toEqual({ ok: true, source: 'canonical', linkedSession: expected });
    expect(resolveLinkedExternalSessionMetadataV1({ externalSessionV1: retained }))
      .toEqual({ ok: false, error: 'linked_session_invalid', reason: 'canonical_invalid' });
    expect(() => buildLinkedExternalSessionMetadataV1({}, retained)).toThrow();
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: {
      ...retained, qualifiedIdentity: { ...retained.qualifiedIdentity,
        agent: { ...retained.qualifiedIdentity.agent, localId: 7 } },
    } })).toBeNull();
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: {
      ...retained, qualifiedIdentity: { ...retained.qualifiedIdentity,
        source: { ...retained.qualifiedIdentity.source, kind: 'claudeConfig' } },
    } })).toBeNull();
    for (const alias of ['providerId', 'agentRuntimeDescriptorV1']) {
      expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ externalSessionV1: {
        ...link, [alias]: undefined,
      } })).toBeNull();
    }
  });

  it('reads retained released links and conversion tombstones without relaxing released identity controls', () => {
    const released = { v: 1 as const, providerId: 'codex', machineId: 'machine-1', remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'user' },
      followPolicyV1: { v: 1 as const, policy: 'background_follow' as const, updatedAtMs: 10 } };
    const { providerId: _providerId, ...fields } = released;
    const expected = { ...fields, agentId: 'codex', source: { ...released.source, retired: true } };
    const retained = { ...released, retired: true, source: { ...released.source, retired: true },
      followPolicyV1: { ...released.followPolicyV1, retired: true } };
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ directSessionV1: retained })).toEqual(expected);
    expect(resolveLinkedExternalSessionMetadataV1({ externalSessionV1: expected, directSessionV1: retained }, 'stored'))
      .toEqual({ ok: true, source: 'canonical', linkedSession: expected });
    expect(resolveLinkedExternalSessionMetadataV1({
      externalSessionV1: { ...expected, source: released.source }, directSessionV1: retained,
    }, 'stored')).toEqual({ ok: false, error: 'linked_session_reconciliation_required', reason: 'source_conflict' });
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ directSessionV1: { ...retained, agentId: 'codex' } })).toBeNull();
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata({ directSessionV1: { ...retained, linkData: {} } })).toBeNull();
    const history = { v: 1 as const, agentId: 'codex', remoteSessionId: 'remote-1', importedAtMs: 10,
      source: released.source, linkData: { opaque: { retired: true } } };
    const annotated = { ...history, retired: true, source: { ...history.source, retired: true } };
    const expectedHistory = { ...history, source: annotated.source };
    expect(ExternalHistoryImportV1Schema.parse(expectedHistory)).toEqual(expectedHistory);
    expect(readExternalHistoryImportV1FromMetadata({ externalHistoryImportV1: annotated })).toEqual(expectedHistory);
    expect(resolveExternalHistoryImportV1FromMetadata({ externalHistoryImportV1: annotated }, 'stored'))
      .toEqual({ state: 'valid', historyImport: expectedHistory });
    expect(resolveExternalHistoryImportV1FromMetadata({ externalHistoryImportV1: annotated }))
      .toEqual({ state: 'invalid', error: 'external_history_import_invalid' });
    expect(readExternalHistoryImportV1FromMetadata({ externalHistoryImportV1: { ...annotated, importedAtMs: -1 } })).toBeNull();
    expect(ExternalHistoryImportV1Schema.safeParse(annotated).success).toBe(false);
    const { agentId: _agentId, linkData: _linkData, ...historicalFields } = history;
    expect(readExternalHistoryImportV1FromMetadata({ externalHistoryImportV1: {
      ...historicalFields, providerId: 'codex', retired: true,
    } })).toEqual({ ...historicalFields, agentId: 'codex' });
  });

  it('reads retained follow facts while preserving normalization and known-field refusal', () => {
    expect(readExternalSessionFollowPolicyV1({ v: 1, policy: 'background_follow', updatedAtMs: 10.9, retired: true }, 'stored'))
      .toEqual({ v: 1, policy: 'background_follow', updatedAtMs: 10 });
    expect(readExternalSessionFollowPolicyV1({ v: 1, policy: 'background_follow', retired: true })).toBeNull();
    const status = { v: 1 as const, status: 'active' as const, reason: ' ready ', updatedAtMs: 10, retired: true };
    expect(readExternalSessionFollowStatusV1(status, 'stored')).toEqual({ v: 1, status: 'active', reason: 'ready', updatedAtMs: 10 });
    expect(readExternalSessionFollowStatusV1(status)).toBeNull();
    expect(ExternalSessionFollowStatusV1Schema.safeParse(status).success).toBe(false);
    const issue = { v: 1 as const, code: ' paused ', message: ' retry ', observedAtMs: 10, retired: true };
    expect(readExternalSessionFollowIssueV1(issue, 'stored')).toEqual({ v: 1, code: 'paused', message: 'retry', observedAtMs: 10 });
    expect(readExternalSessionFollowIssueV1(issue)).toBeNull();
    expect(ExternalSessionFollowIssueV1Schema.safeParse(issue).success).toBe(false);
    expect(readExternalSessionFollowPolicyV1({ v: 1, policy: 'unknown', retired: true }, 'stored')).toBeNull();
    expect(readExternalSessionFollowStatusV1({ ...status, updatedAtMs: -1 }, 'stored')).toBeNull();
    expect(readExternalSessionFollowIssueV1({ ...issue, code: '' }, 'stored')).toBeNull();
  });
});
