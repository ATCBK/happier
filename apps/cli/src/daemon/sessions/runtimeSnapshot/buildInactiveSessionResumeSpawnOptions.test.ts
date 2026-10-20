import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';
import {
  buildQualifiedPluginContributionKey,
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
} from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { buildInactiveSessionResumeSpawnOptions, resolveSessionPersistedRuntimeIdentity } from './buildInactiveSessionResumeSpawnOptions';

const EXTERNAL_PLUGIN_ID = 'acme.inactive-resume';
const EXTERNAL_LOCAL_AGENT_ID = 'acme-agent';
const EXTERNAL_AGENT_ID = buildQualifiedPluginContributionKey({ pluginId: EXTERNAL_PLUGIN_ID, localId: EXTERNAL_LOCAL_AGENT_ID });
let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;

beforeAll(async () => {
  runtime = await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude', EXTERNAL_PLUGIN_ID] },
    plugins: [{
      manifest: createPluginManifestV2Fixture({ id: EXTERNAL_PLUGIN_ID, contributes: { agents: [{
        id: EXTERNAL_LOCAL_AGENT_ID, title: 'Acme Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      }] } }),
      files: { 'daemon.mjs': [
        'export async function createRuntime() { throw new Error("Native Agent execution is outside inactive resume composition"); }',
        `export function activate(api) { api.agents.register('${EXTERNAL_LOCAL_AGENT_ID}', createRuntime, { sessionRunnerFactory: { module: './daemon.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }`,
      ].join('\n') },
    }],
  });
});
afterAll(async () => {
  try { await runtime?.dispose(); }
  finally { await pluginReloadController.shutdown(); }
});

describe('buildInactiveSessionResumeSpawnOptions', () => {
  it.each(['custom-acp', 'happier.agent.custom-acp/custom-acp'])('retains the exact configured definition when resuming the declared %s Agent', (agentId) => {
    const descriptor = { v: 1, agentId, agent: { definitionId: 'review-bot' } };
    const metadata = {
      flavor: 'custom-acp', runtimeDescriptorV1: descriptor,
      acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'review-bot', title: 'Review Bot' },
    };
    expect(resolveSessionPersistedRuntimeIdentity(metadata)).toEqual({
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
      runtimeDescriptorV1: descriptor,
    });
    expect(resolveSessionPersistedRuntimeIdentity({ ...metadata,
      runtimeDescriptorV1: { ...descriptor, agent: { definitionId: 'other-bot' } },
    })).toBeNull();
  });

  it('does not consent to recreating a managed session directory during an automatic resume', () => {
    const result = buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-managed',
      rawSession: { machineId: 'machine-1', path: '/private/chat' },
      metadata: {
        machineId: 'machine-1', path: '/private/chat', flavor: 'codex',
        sessionDirectoryV1: { v: 1, kind: 'managed', futureField: 'ignored' },
      },
    });
    expect(result).toMatchObject({ directoryKind: 'managed', approvedNewDirectoryCreation: false });
  });

  it.each(['codex', 'claude', 'acp:review-bot', 'uninitialized'] as const)('reconstructs current %s runtime while retaining immutable creation profile and Saved Secret provenance', (currentAgentId) => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'creation-resume',
    });
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/home/coder/project' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: 'profile-shared',
        secretReferenceOverlay: {
          v: 1,
          bindings: {
            OPENAI_API_KEY: {
              ref: 'happier:shared-secret:v1:shared-openai',
              revision: 9,
            },
          },
        },
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        capabilitySelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });

    const birthMetadata = {
      machineId: 'machine-1', path: '/home/coder/project',
      sessionCreationCorrespondenceV1: { ...correspondence, futureField: 'ignored' },
    };
    const metadata = currentAgentId === 'uninitialized' ? birthMetadata : projectCurrentAgentSessionView({
      machineId: 'machine-1', path: '/home/coder/project', flavor: 'codex',
      sessionCreationCorrespondenceV1: { ...correspondence, futureField: 'ignored' },
    }, {
      agentId: currentAgentId, agentScopedCurrentState: 'clear',
      configuredBackend: currentAgentId === 'acp:review-bot'
        ? { v: 1, backendId: 'review-bot', title: 'Review Bot', updatedAt: 2 } : null,
    });
    const result = buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-1',
      rawSession: { machineId: 'machine-1', path: '/home/coder/project' },
      metadata,
    });
    expect(result).toMatchObject({
      sessionCreationTag,
      sessionCreationCorrespondence: correspondence,
      profileId: 'profile-shared',
      secretReferenceOverlay: correspondence.recipe.secretReferenceOverlay,
    });
    if (currentAgentId === 'acp:review-bot') {
      expect(result?.backendTarget).toEqual({
        kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
      });
    } else if (currentAgentId === 'claude') {
      expect(result?.backendTarget).toEqual({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' });
    } else {
      expect(result?.agentTarget).toEqual(correspondence.recipe.agentTarget);
    }
    expect(metadata.sessionCreationCorrespondenceV1).toEqual({ ...correspondence, futureField: 'ignored' });

  });

  it('rebases the persisted agent workspace onto the selected daemon machine workspace', () => {
    const result = buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-1',
      rawSession: {
        machineId: 'machine-1',
        path: '/home/coder/project',
      },
      metadata: {
        machineId: 'machine-1',
        path: '/home/coder/project',
        flavor: 'codex',
        sessionWorkspaceLocationV1: {
          v: 1,
          machineId: 'machine-1',
          agentPath: '/home/coder/project',
          machinePath: '/Users/alice/project',
        },
      },
    });

    expect(result?.directory).toBe('/Users/alice/project');
  });

  it('rebuilds an inactive Session for an active external Agent from its durable runtime identity', () => {
    const result = buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-external',
      rawSession: {
        machineId: 'machine-1',
        path: '/home/coder/project',
      },
      metadata: {
        machineId: 'machine-1',
        path: '/home/coder/project',
        runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: {} },
      },
    });

    expect(result).toMatchObject({
      backendTarget: {
        kind: 'backend',
        backendId: EXTERNAL_AGENT_ID,
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: { v: 1, agentId: EXTERNAL_AGENT_ID, agent: {} },
    });
  });

  describe('one-flat-vendor-key invariant', () => {
    const baseParams = {
      sessionId: 'session-1',
      rawSession: { machineId: 'machine-1', path: '/home/coder/project' },
    } as const;

    it('resumes a flavor-declared Session that also carries a stale foreign resume key', () => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          flavor: 'codex',
          codexSessionId: 'codex-1',
          // Legacy residue from an earlier Agent. Before the one-key invariant
          // this permanently bricked the Session: identity was unanimity-voted
          // across every present flat key, so two keys resolved to nothing.
          claudeSessionId: 'stale-claude',
        },
      });

      expect(result?.backendTarget?.backendId).toBe('codex');
    });

    it('resumes a runtime-descriptor-declared Session that also carries a stale foreign resume key', () => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
          codexSessionId: 'codex-1',
          claudeSessionId: 'stale-claude',
        },
      });

      expect(result?.backendTarget?.backendId).toBe('codex');
    });

    it('fails closed when two flat resume keys carry no higher-authority identity', () => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          codexSessionId: 'codex-1',
          claudeSessionId: 'claude-1',
        },
      });

      expect(result).toBeNull();
    });

    it('still resumes a Session whose identity is inferred from exactly one flat resume key', () => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          codexSessionId: 'codex-1',
        },
      });

      expect(result?.backendTarget?.backendId).toBe('codex');
    });

    it('still resumes a configured ACP Session, whose flavor carries an acp: sentinel', () => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          flavor: 'acp:custom-kiro',
          acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'custom-kiro', title: 'Custom Kiro' },
        },
      });

      expect(result?.backendTarget?.sourceKind).toBe('configured');
      expect(result?.backendTarget?.backendId).toBe('custom-kiro');
    });

    it.each(['codex', 'acp:other-backend'])('refuses a Session whose declared %s identity contradicts its explicit backend target', (flavor) => {
      const result = buildInactiveSessionResumeSpawnOptions({
        ...baseParams,
        metadata: {
          machineId: 'machine-1',
          path: '/home/coder/project',
          flavor,
          acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'my-acp', title: 'My ACP' },
        },
      });

      expect(result).toBeNull();
    });
  });
});
