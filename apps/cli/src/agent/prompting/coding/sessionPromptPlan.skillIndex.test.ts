import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { PLUGIN_MANIFEST as kimi } from '../../../../../../packages/plugins/kimi/src/manifest';
import { PLUGIN_MANIFEST as coderabbit } from '../../../../../../packages/plugins/review-coderabbit/src/manifest';
import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('session skill index delivery', () => {
  beforeEach(() => { installEmptyProjectAccountRowsHttpBoundary(); });
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('uses real Kimi and CodeRabbit delivery declarations and includes only invocable index metadata', async () => {
    const items = Array.from({ length: 140 }, (_, i) => ({ skillId: `skill-${i}`, name: `review-${i}`, digest: '',
      description: `Review description ${i}`, disableModelInvocation: false, userInvocable: true }));
    Object.assign(items[0]!, { skillMd: 'Private full skill instructions' });
    items.push({ skillId: 'manual', name: 'manual', digest: '', description: 'Only invoked by the user',
      disableModelInvocation: true, userInvocable: true });
    for (const manifest of [kimi, coderabbit]) {
      const agent = PluginAgentContributionV2Schema.parse(manifest.contributes.agents?.[0]);
      const delivery = ('tools' in agent.capabilities ? agent.capabilities.tools?.delivery : undefined) ?? 'unsupported';
      expect('skills' in agent.capabilities ? agent.capabilities.skills?.delivery : undefined).toBe('none');
      const resolve = createSessionPromptPlanResolver({
        opts: { credentials: { token: 'skill-index-test', encryption: null } },
        session: Object.assign(createApiSessionClientFixture(), { sessionId: 'session', getMetadataSnapshot: () => createTestMetadata() }),
        agentId: agent.id, machineId: 'machine', directory: '/repo', memoryRecallGuidanceEnabled: false,
        readNativeSessionId: () => null,
        readSessionSkills: () => ({ plan: { plan: delivery === 'unsupported' ? 'none' : 'index',
          items: [], nativeDisables: [], diagnostics: [] }, indexItems: items }),
        daemonBridge: { resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }),
          resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
          resolveComposerReference: async () => { throw new Error('Unexpected composer request'); },
          resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
          afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
          transformAgentContext: async () => { throw new Error('Unexpected context request'); },
          transformSessionInput: async () => { throw new Error('Unexpected input request'); },
          transformAgentRequest: async () => { throw new Error('Unexpected agent request'); } },
      });
      const text = await resolve({ baseOverride: 'Base instructions' });
      if (agent.id === 'kimi') {
        expect(delivery).toBe('native_mcp');
        expect(text).toContain('review-139: Review description 139');
        expect(text).toContain('skills_read');
      } else {
        expect(delivery).toBe('unsupported');
        expect(text).not.toContain('review-0:');
        expect(text).not.toContain('skills_read');
      }
      expect(text).not.toContain('Only invoked by the user');
      expect(text).not.toContain('Private full skill instructions');
    }
  });
});
