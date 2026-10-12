import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MANIFEST as kimi } from '../../../../../../packages/plugins/kimi/src/manifest';
import { PLUGIN_MANIFEST as coderabbit } from '../../../../../../packages/plugins/review-coderabbit/src/manifest';
import { createSessionPromptPlanResolver } from './sessionPromptPlan';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

describe('session skill index delivery', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('uses real Kimi and CodeRabbit delivery declarations and includes only invocable index metadata', async () => {
    const items = Array.from({ length: 140 }, (_, i) => ({ skillId: `skill-${i}`, name: `review-${i}`, digest: '',
      description: `Review description ${i}`, disableModelInvocation: false, userInvocable: true }));
    items.push({ skillId: 'manual', name: 'manual', digest: '', description: 'Only invoked by the user',
      disableModelInvocation: true, userInvocable: true });
    for (const manifest of [kimi, coderabbit]) {
      const agent = manifest.contributes.agents[0]!;
      expect(agent.capabilities.skills?.delivery).toBe('none');
      const resolve = createSessionPromptPlanResolver({
        opts: { credentials: { token: 'skill-index-test', encryption: null } },
        session: { sessionId: 'session', getMetadataSnapshot: () => createTestMetadata() },
        agentId: agent.id, machineId: 'machine', directory: '/repo', memoryRecallGuidanceEnabled: false,
        readNativeSessionId: () => null,
        readSessionSkills: () => ({ plan: { plan: agent.capabilities.tools?.delivery === 'unsupported' ? 'none' : 'index',
          items: [], nativeDisables: [], diagnostics: [] }, indexItems: items }),
        daemonBridge: { resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }) },
      });
      const text = await resolve({ baseOverride: 'Base instructions' });
      if (agent.id === 'kimi') {
        expect(agent.capabilities.tools?.delivery).toBe('native_mcp');
        expect(text).toContain('review-139: Review description 139');
        expect(text).toContain('skills_read');
      } else {
        expect(agent.capabilities.tools?.delivery).toBe('unsupported');
        expect(text).not.toContain('review-0:');
        expect(text).not.toContain('skills_read');
      }
      expect(text).not.toContain('Only invoked by the user');
      expect(text).not.toContain('Private full skill instructions');
    }
  });
});
