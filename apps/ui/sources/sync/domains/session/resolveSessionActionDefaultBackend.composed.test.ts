import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
// Exercise the CLI producer without absorbing its source into the UI compiler project.
import { buildSessionMetadataEnvelopeCreateFields } from '../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { parsePlainSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readSessionPresentationAgentId } from './presentation/readSessionPresentationAgentId';

import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTargetKey,
} from './resolveSessionActionDefaultBackend';

describe('Session spawn metadata producer → default target', () => {
      it.each(['custom-acp', 'happier.agent.custom-acp/custom-acp'])('keeps spawned %s unresolved until its private birth facts hydrate', runtimeAgentId => {
        // Replay QA-R13b's admitted Alpha spawn selection through the same
        // layout-v1 metadata producers the Session create transport consumes.
        const agentTarget = { kind: 'agent' as const,
          identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
          definitionId: 'qa-a-acp-alpha' };
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'b'.repeat(43)}`, recipe: {
          execution: { machineId: 'machine-a', directory: { kind: 'path', path: '/project' } },
          organization: { folderId: null, tagIds: [] }, agentTarget, modelSelection: null, profileId: null,
          requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
          capabilitySelection: null, transcriptStorage: 'persisted', terminal: null, agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        } });
        const spawnMetadata = { path: '/project', host: 'machine-a',
          runtimeDescriptorV1: { v: 1 as const, agentId: runtimeAgentId, agent: { definitionId: 'qa-a-acp-alpha' } },
          sessionCreationCorrespondenceV1: correspondence };
        const fields = buildSessionMetadataEnvelopeCreateFields({
          credentials: { token: 'spawn-fixture', encryption: null }, accountEncryptionMode: 'plain',
          storedContentMode: 'plain', metadata: spawnMetadata, agentState: null,
        });
        const row = SessionCurrentProjectionRecordV1Schema.parse({
          id: 'spawned-alpha', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          archivedAt: null, encryptionMode: 'plain', dataEncryptionKey: null,
          metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
          metadataVersion: 1, agentState: fields.agentState, agentStateVersion: 0,
          ownerMetadata: fields.ownerMetadata,
          share: null, responsibleAccountId: null, responsibleAccount: null,
          effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        });
        const sharedMetadata = parsePlainSessionMetadata(row.metadata, row.metadataLayoutVersion);
        const session = createSessionFixture({ ...row,
          metadata: sharedMetadata, ownerMetadataView: null });
        const agentId = readSessionPresentationAgentId(session);
        expect(agentId).toBe(runtimeAgentId);
        expect(resolveSessionActionDefaultTargetKey(resolveSessionActionDefaultBackend({ session }))).toBeNull();
        const hydrated = { ...session, ownerMetadataView: projectSessionOwnerCompatibilityViewV1({
          sharedMetadata, ownerMetadata: fields.ownerMetadata.t === 'plain' ? fields.ownerMetadata.v : null }) };
        expect(resolveSessionActionDefaultTargetKey(resolveSessionActionDefaultBackend({ session: hydrated })))
          .toBe('agent:happier.agent.custom-acp/custom-acp:definition:qa-a-acp-alpha');
      });
});
