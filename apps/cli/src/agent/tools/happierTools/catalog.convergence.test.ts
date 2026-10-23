import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { listActionCliCommandDeclarations } from '@happier-dev/protocol/actions/actionSpecs';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { listBuiltInHappierTools } from './listBuiltInHappierTools';

describe('Happier built-in tool catalog convergence', () => {
  it('exposes the catalog entrypoints and CLI help roots used by the first-party guide', () => {
    const tools = listBuiltInHappierTools({
      surface: 'agent',
      registry: createResolvedContributionRegistry({ agents: [] }),
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    });
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'action_spec_search', 'action_spec_get', 'action_execute',
    ]));
    expect(tools.find(tool => tool.name === 'action_spec_search')?.actionId).toBe('action.spec.search');
    expect(tools.find(tool => tool.name === 'action_spec_get')?.actionId).toBe('action.spec.get');

    const roots = new Set(listActionCliCommandDeclarations().map(command => command.binding.path[0]));
    for (const root of ['skills', 'mcp', 'session']) expect(roots.has(root)).toBe(true);
  });

  it.each([
    { name: 'execution_run_start', actionId: 'execution.run.start', surface: 'cli' },
    { name: 'plugins_reload', actionId: 'plugins.reload', surface: 'agent' },
  ] as const)('keeps $name Action-backed and withdraws it when its canonical policy disables it', ({ name, actionId, surface }) => {
    const registry = createResolvedContributionRegistry({ agents: [] });
    const enabledTools = listBuiltInHappierTools({
      surface, registry, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }),
    });
    expect(enabledTools.filter((tool) => tool.name === name)).toEqual([
      expect.objectContaining({ name, actionId }),
    ]);

    const disabledTools = listBuiltInHappierTools({
      surface,
      registry,
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1, actions: { [actionId]: { enabled: false } },
      }),
    });
    expect(disabledTools.map((tool) => tool.name)).toContain('action_execute');
    expect(disabledTools.map((tool) => tool.name)).not.toContain(name);
  });
});
