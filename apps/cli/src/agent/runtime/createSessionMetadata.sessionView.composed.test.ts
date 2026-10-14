import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { applyModelIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { createSessionMetadata, captureSessionLaunchControlMetadata } from './createSessionMetadata';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { resolveSessionStartModelSelection } from '@/cli/resolveSessionStartModelSelection';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { buildLiveSessionAuthoringContext } from '../../../../ui/sources/components/sessions/authoring/context/buildLiveSessionAuthoringContext';
import { resolveSessionComposerStateFromAuthoringContext } from '../../../../ui/sources/components/sessions/authoring/context/resolveSessionComposerStateFromAuthoringContext';
import { describeEffectiveModelMode } from '../../../../ui/sources/sync/domains/models/describeEffectiveModelMode';
import { resolveSessionModelSelectionDisposition } from '../../../../ui/sources/sync/domains/models/resolveSessionModelSelectionDisposition';

describe('CLI metadata → Session view model readers', () => {
  it.each(['qa-a-acp-alpha', 'qa-c-exact-args', null])('loads and retains the applied selection for %s', definitionId => {
    const agentId = definitionId ? 'custom-acp' : 'claude';
    const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
      identity: definitionId ? CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 : { pluginId: 'happier.agent.claude', localId: 'claude' },
      ...(definitionId ? { definitionId } : {}),
    });
    const selection = resolveSessionStartModelSelection({ backendTarget: target, legacyModelId: 'local-model', nowMs: 10 });
    if (!selection) throw new Error('Expected CLI model selection');
    const metadata = MetadataSchema.parse(createSessionMetadata({ flavor: agentId, machineId: 'machine', directory: '/project',
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
      runtimeDescriptorV1: { v: 1, agentId, agent: definitionId ? { definitionId } : {} },
      modelSelectionIntent: { v: 1, updatedAt: selection.updatedAt, selection: selection.ref },
      augmentMetadata: current => ({ ...current,
        ...(definitionId ? buildConfiguredAcpBackendSessionMetadata({ backendId: definitionId, title: 'Local Agent' }) : {}),
        sessionAppliedModelV1: { v: 1, provider: agentId, updatedAt: 11, modelId: selection.ref.modelId, selection: selection.ref },
      }),
    }).metadata);
    const context = buildLiveSessionAuthoringContext({ session: createSessionFixture({ metadata }) });
    const composer = resolveSessionComposerStateFromAuthoringContext(context, { fallbackAgentId: agentId });
    const description = describeEffectiveModelMode({ agentType: agentId, selectedModelId: composer.modelMode, metadata });
    expect(description).toMatchObject({ selectedModelId: 'local-model', appliedModelId: 'local-model' });
    const targetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(target));
    expect(context.snapshot.modelSelection?.ref.agentTargetKey).toBe(targetKey);
    expect(resolveSessionModelSelectionDisposition({ agentId, agentTargetKey: targetKey, metadata,
      sessionActive: false, currentRunnerProcessIdentity: null }).proposedSelection).toEqual(selection.ref);
    const stale = applyModelIntentSessionMetadata(metadata, { updatedAt: 12,
      selection: { ...selection.ref, agentTargetKey: 'agent:happier.agent.codex/codex' } });
    expect(buildLiveSessionAuthoringContext({ session: createSessionFixture({ metadata: stale }) }).snapshot.modelSelection).toBeNull();
  });
});
