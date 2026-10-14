import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { buildSessionMetadataEnvelopeCreateFields } from '../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { parsePlainSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readSessionPresentationAgentId } from './presentation/readSessionPresentationAgentId';

import {
  resolveSessionActionDefaultBackend,
  resolveSessionActionDefaultTarget,
  resolveSessionActionDefaultTargetKey,
} from './resolveSessionActionDefaultBackend';

	describe('resolveSessionActionDefaultBackend', () => {
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
      it('retains the canonical Agent target from stored birth provenance with retired fields', () => {
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'example.custom', localId: 'agent' } };
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`, recipe: {
            execution: { machineId: 'machine-a', directory: { kind: 'path', path: '/project' } },
            organization: { folderId: null, tagIds: [] }, agentTarget, modelSelection: null, profileId: null,
            requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
            capabilitySelection: null, transcriptStorage: 'persisted', terminal: null, agentSessionStartupInstructionsMarkerV1: null,
            checkout: null,
        } });
        const retainedCorrespondence = { ...correspondence, retired: true, recipe: { ...correspondence.recipe, retired: true } };
        const resolved = resolveSessionActionDefaultBackend({ session: createSessionFixture({
            metadata: { path: '/project', host: 'machine-a', sessionCreationCorrespondenceV1: retainedCorrespondence },
        }) });
        expect(resolved?.agentTarget).toEqual(agentTarget);
        expect(resolveSessionActionDefaultTargetKey(resolved)).toBe('agent:example.custom/agent');
      });
	  it('returns configured ACP backend targets from session metadata while keeping a built-in fallback id', () => {
	    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'customAcp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'acp-backend',
            title: 'Review Bot',
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
      fallbackAgentId: 'claude',
	    });

	    expect(resolved).toEqual({
	      agentTarget: null,
	      backendTarget: {
	        kind: 'backend',
	        backendId: 'acp-backend',
	        configuredBackendId: 'acp-backend',
	        sourceKind: 'configured',
	      },
	      defaultAgentId: null,
	      defaultBackendId: 'claude',
	      displayAgentType: 'claude',
	    });
	    expect(resolveSessionActionDefaultTarget(resolved)).toEqual(resolved?.backendTarget);
	    expect(resolveSessionActionDefaultTargetKey(resolved)).toBe('agent:happier.agent.custom-acp/custom-acp:definition:acp-backend');
	  });

  it('keeps the concrete configured backend target while exposing canonical built-in session defaults for configured ACP sessions', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'customAcp',
          agent: 'customAcp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
      fallbackAgentId: 'claude',
	    });

	    expect(resolved).toEqual({
	      agentTarget: null,
	      backendTarget: {
	        kind: 'backend',
	        backendId: 'review-bot',
	        configuredBackendId: 'review-bot',
	        sourceKind: 'configured',
	      },
	      defaultAgentId: null,
	      defaultBackendId: 'claude',
	      displayAgentType: 'claude',
	    });
	  });

  it('falls back to the inferred built-in agent when no configured ACP backend metadata exists', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'codex',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
	    });

	    expect(resolved).toEqual({
	      agentTarget: {
	        kind: 'agent',
	        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
	      },
	      backendTarget: null,
	      defaultAgentId: 'codex',
	      defaultBackendId: 'codex',
	      displayAgentType: 'codex',
	    });
	    expect(resolveSessionActionDefaultTarget(resolved)).toEqual(resolved?.agentTarget);
	    expect(resolveSessionActionDefaultTargetKey(resolved)).toBe('agent:happier.agent.codex/codex');
	  });

  it('treats a built-in metadata.agent as the default built-in target when no enabled-agent filter is provided', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          agent: 'codex',
        },
      } as any,
	    });

	    expect(resolved).toEqual({
	      agentTarget: {
	        kind: 'agent',
	        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
	      },
	      backendTarget: null,
	      defaultAgentId: 'codex',
	      defaultBackendId: 'codex',
	      displayAgentType: 'codex',
	    });
	  });

  it('keeps the canonical Agent identity when a legacy review alias is present', () => {
    const resolved = resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          flavor: 'claude',
          agent: 'coderabbit',
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
	    });

	    expect(resolved).toEqual({
	      agentTarget: {
	        kind: 'agent',
	        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
	      },
	      backendTarget: null,
	      defaultAgentId: 'claude',
	      defaultBackendId: 'claude',
	      displayAgentType: 'claude',
	    });
	  });

  it('does not synthesize a built-in target from a non built-in metadata.agent without another built-in signal', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          agent: 'acme.review-bot',
        },
      } as any,
    })).toBeNull();
  });

  it('fails closed for an external runtime descriptor when resolving a built-in default', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.agent',
            provider: {},
          },
        },
      } as any,
    })).toBeNull();
  });

  it('does not replace an external runtime owner with the first enabled built-in backend', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.review-bot',
            provider: {},
          },
        },
      } as any,
      enabledAgentIds: ['claude', 'codex'],
    })).toBeNull();
  });

  it('returns null when no explicit backend or built-in agent signal exists', () => {
    expect(resolveSessionActionDefaultBackend({
      session: {
        id: 's1',
        metadata: {},
      } as any,
      enabledAgentIds: [],
    })).toBeNull();
  });
});
