import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  SpawnCapabilitiesPreviewOutputV1Schema,
} from '@happier-dev/protocol/actions/specs/sessionCapabilities';

import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

const rpc = vi.hoisted(() => vi.fn<(request: { machineId: string; method: string; payload: unknown }) => Promise<unknown>>());
// Only the daemon transport is substituted; Action admission, dispatch and output parsing stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
installDisconnectedServerSocketBoundary();
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { useSkillMachineTruth } = await import('./useSkillMachineTruth');

afterEach(standardCleanup);

function machine(machineId: string, agentIds: string[], offline = false): ReachMachine {
  return { machineId, platform: 'posix', agentIds, name: machineId, online: !offline, offline, lastSeenAt: offline ? 1 : null };
}

/** A real preview answer: parsed through the strict producer schema before the hook ever sees it. */
function previewAnswer(skillId: string, state: 'delivered' | 'masked_by_native') {
  return SpawnCapabilitiesPreviewOutputV1Schema.parse({
    ok: true,
    machinePlatform: 'posix',
    mcp: { strictMode: false, items: [], detected: [] },
    skills: {
      items: [{
        kind: 'skill', id: skillId, name: skillId, selected: true, selectable: true, reason: 'rule_on',
        decidedBy: null, sessionOverride: null, state,
      }],
      plan: { plan: 'session_dir', items: [], nativeDisables: [], diagnostics: [] },
    },
    applyTiming: { mcp: { t: 'new_sessions_only' }, skills: { t: 'new_sessions_only' } },
  });
}

describe('useSkillMachineTruth', () => {
  it('keeps per-Agent truth and failures separate through the real preview Action, excludes offline and unsupported targets, and refreshes changed rules', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await createPlainArtifactHomeFixture('https://skill-machine-truth.test', {
      serverFeatures: createRootLayoutFeaturesResponse(),
      handleRequest: async (path, init) => path === '/v2/account/settings/history'
        ? Response.json({ snapshots: [] }) : catalog.handle(path, init),
    });
    const asked: unknown[] = [];
    let failed = false;
    rpc.mockReset();
    rpc.mockImplementation(async request => {
      expect(request.method).toBe(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
      asked.push(request.payload);
      const { machineId, agentId } = request.payload as { machineId: string; agentId: string };
      if (failed && machineId === 'nl1' && agentId === 'claude') throw new Error('rpc_unreachable');
      return previewAnswer('s1', machineId === 'nl1' && agentId === 'claude' ? 'masked_by_native' : 'delivered');
    });
    const machines = [
      machine('nl1', ['claude', 'codex', 'coderabbit']),
      machine('nl2', ['claude']),
      machine('away', ['claude', 'codex'], true),
      { ...machine('unknown', ['codex']), online: null },
    ];
    const hook = await renderHook(({ rulesKey }: { rulesKey: string }) => {
      const action = useMountedActionExecution(home.home.id);
      return useSkillMachineTruth({ skillId: 's1', machines, projection: [], rulesKey,
        execute: action.execute, ready: action.ready });
    }, { initialProps: { rulesKey: 'k' } });
    try {
      await vi.waitFor(() => {
        const nl1 = hook.getCurrent().find((entry) => entry.machine.machineId === 'nl1')!;
        expect(nl1.facts.get('claude')?.kind).toBe('masked');
        expect(nl1.facts.get('codex')?.kind).toBe('delivered');
      });
      const byMachine = Object.fromEntries(hook.getCurrent().map((entry) => [entry.machine.machineId, entry]));
      expect(byMachine['nl2']!.facts.get('claude')?.kind).toBe('delivered');
      expect(byMachine['away']!.facts.size).toBe(0);
      expect(byMachine['unknown']!.facts.size).toBe(0);
      expect(byMachine['nl1']!.cannotLoad).toContain('coderabbit');
      expect([...asked].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
        { machineId: 'nl1', agentId: 'claude' },
        { machineId: 'nl1', agentId: 'codex' },
        { machineId: 'nl2', agentId: 'claude' },
      ]);
      failed = true;
      await hook.rerender({ rulesKey: 'changed-rules' });
      await vi.waitFor(() => {
        const nl1 = hook.getCurrent().find(entry => entry.machine.machineId === 'nl1')!;
        expect(nl1.facts.get('claude')?.kind).toBe('failed');
        expect(nl1.facts.get('codex')?.kind).toBe('delivered');
      });
      expect(hook.getCurrent().find(entry => entry.machine.machineId === 'nl2')!.facts.get('claude')?.kind).toBe('delivered');
      expect(asked).toHaveLength(6);
    } finally {
      await hook.unmount();
      await home.dispose();
    }
  });
});
