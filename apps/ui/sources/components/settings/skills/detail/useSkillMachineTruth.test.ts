import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import {
  SpawnCapabilitiesPreviewOutputV1Schema,
} from '@happier-dev/protocol/actions/specs/sessionCapabilities';

import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

const { useSkillMachineTruth } = await import('./useSkillMachineTruth');

afterEach(standardCleanup);

function machine(machineId: string, agentIds: string[], offline = false): ReachMachine {
  return { machineId, platform: 'posix', agentIds, name: machineId, offline, lastSeenAt: offline ? 1 : null };
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
  it('asks the machine once per online machine and skill-capable Agent, never an offline one, and each Agent keeps its own answer', async () => {
    const asked: unknown[] = [];
    // The daemon is the boundary: Claude's native copy wins on `nl1`, and Codex's preview there fails.
    const execute = vi.fn(async (_actionId: 'sessions.spawn.capabilities.preview', input: unknown) => {
      asked.push(input);
      const { machineId, agentId } = input as { machineId: string; agentId: string };
      if (machineId === 'nl1' && agentId === 'codex') throw new Error('rpc_unreachable');
      return { ok: true as const, result: previewAnswer('s1', machineId === 'nl1' ? 'masked_by_native' : 'delivered') };
    });
    const machines = [
      machine('nl1', ['claude', 'codex']),
      machine('nl2', ['claude']),
      machine('away', ['claude', 'codex'], true),
    ];
    const hook = await renderHook(() => useSkillMachineTruth({
      skillId: 's1', machines, projection: [], rulesKey: 'k', execute, ready: true,
    }));
    try {
      await vi.waitFor(() => {
        const nl1 = hook.getCurrent().find((entry) => entry.machine.machineId === 'nl1')!;
        expect(nl1.facts.get('claude')?.kind).toBe('masked');
        expect(nl1.facts.get('codex')?.kind).toBe('failed');
      });
      const byMachine = Object.fromEntries(hook.getCurrent().map((entry) => [entry.machine.machineId, entry]));
      expect(byMachine['nl2']!.facts.get('claude')?.kind).toBe('delivered');
      expect(byMachine['away']!.facts.size).toBe(0);
      expect([...asked].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
        { machineId: 'nl1', agentId: 'claude' },
        { machineId: 'nl1', agentId: 'codex' },
        { machineId: 'nl2', agentId: 'claude' },
      ]);
    } finally {
      await hook.unmount();
    }
  });
});
