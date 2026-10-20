import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { McpImportCommitV1Schema } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import { installValueRefsCommonModuleMocks } from '@/components/ui/forms/valueRefs/valueRefsTestHelpers';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { useMcpFoundAdoption as UseMcpFoundAdoption } from './useMcpFoundAdoption';

installValueRefsCommonModuleMocks();
afterEach(standardCleanup);

const found = DetectedMcpServerV1Schema.parse({
  provider: 'claude', name: 'github', transport: 'stdio', stdio: { command: 'npx', args: ['-y', 'github-mcp'] },
  envKeys: ['GITHUB_TOKEN'], enabled: true, source: { kind: 'user', path: '/home/dev/.claude.json' },
});

/** The real hook (its preview model comes from the real import producer) under the panel that renders it. */
async function mount() {
  const execute = vi.fn(async (_id: string, _input: unknown) => ({
    ok: true as const,
    result: McpImportCommitV1Schema.parse({ ok: true, revision: 2, serverIds: ['saved-1'], duplicates: [], movedSecrets: [] }),
  }));
  const { useMcpFoundAdoption } = await import('./useMcpFoundAdoption');
  const { McpFoundAdoptionPanel } = await import('./McpFoundAdoptionPanel');
  let latest: ReturnType<typeof UseMcpFoundAdoption> | null = null;
  const execution = { execute: execute as never, ready: true, isCurrent: () => true };
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
  function Harness() {
    const adoption = useMcpFoundAdoption({ machineId: 'machine-1', scopeKey: 'home', catalog, catalogRevision: 1, execution });
    latest = adoption;
    return <McpFoundAdoptionPanel testID="adopt" adoption={adoption} secrets={[]} scope={null} />;
  }
  const screen = await renderScreen(<Harness />);
  return { screen, execute, adoption: () => latest! };
}

describe('McpFoundAdoptionPanel', () => {
  it('asks for the key a finding names and adds nothing until it has an explicit choice', async () => {
    const { screen, execute, adoption } = await mount();
    await act(async () => { await adoption().begin(found); });

    expect(screen.findByTestId('adopt.server.github.env.row.0.name')).not.toBeNull();
    expect(adoption().canSubmit).toBe(false);
    // Add stays pressable: pressing it with a value still open adds nothing and is what flags that value.
    expect(screen.findByTestId('adopt.add')?.props.disabled).toBe(false);
    await act(async () => { screen.pressByTestId('adopt.add'); });
    expect(execute).not.toHaveBeenCalled();
    expect(adoption().state.status).toBe('choosing');

    const choice: ValueRefV1 = { t: 'literal', v: '${GITHUB_TOKEN}' };
    await act(async () => { adoption().setValue(adoption().model!.servers[0]!.env[0]!.inputId, choice); });
    await act(async () => { screen.pressByTestId('adopt.add'); });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]![0]).toBe('mcp.found.adopt');
    expect(JSON.stringify(execute.mock.calls[0]![1])).toContain('${GITHUB_TOKEN}');
    await vi.waitFor(() => expect(adoption().state).toEqual({ status: 'adopted', serverId: 'saved-1' }));
  });

  it('keeps the choices and offers Retry when the add is refused, and Cancel withdraws the continuation', async () => {
    const { screen, execute, adoption } = await mount();
    execute.mockResolvedValueOnce({ ok: false, errorCode: 'revision_conflict' } as never);
    await act(async () => { await adoption().begin(found); });
    const inputId = adoption().model!.servers[0]!.env[0]!.inputId;
    await act(async () => { adoption().setValue(inputId, { t: 'literal', v: '${GITHUB_TOKEN}' }); });
    await act(async () => { screen.pressByTestId('adopt.add'); });
    await vi.waitFor(() => expect(adoption().state.status).toBe('failed'));
    expect(adoption().answers.rows[inputId]).toEqual({ t: 'literal', v: '${GITHUB_TOKEN}' });
    expect(screen.findByTestId('adopt.add')?.props.disabled).toBe(false);

    await act(async () => { screen.pressByTestId('adopt.cancel'); });
    expect(adoption().state.status).toBe('idle');
    expect(adoption().model).toBeNull();
    expect(screen.findByTestId('adopt.add')).toBeNull();
  });
});
