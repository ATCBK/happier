import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SpawnCapabilitiesPreviewSuccessV1Schema, type SpawnCapabilitiesPreviewOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { projectManagedMcpSelectionV1, projectManagedMcpPreviewEntriesV1 } from '@happier-dev/protocol/mcp/servers/previewV1';
import type { NewSessionMcpSelectionContentProps } from '@/components/sessions/new/components/NewSessionMcpSelectionContent';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

const rpc = vi.hoisted(() => vi.fn());
// The machine network is the only substituted behavior below the real Action and preview owners.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useNewSessionMcpSelection } = await import('./useNewSessionMcpSelection');
let serverId: string;
let producerPreview: Extract<SpawnCapabilitiesPreviewOutputV1, { ok: true }>;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Composer Home', serverUrl: 'https://composer-capabilities.test', accountId: 'composer-owner' });
    rpc.mockReset();
    const settings = { v: 1 as const, strictMode: false, servers: [{ id: 'server', name: 'lint', transport: 'stdio' as const,
        stdio: { command: 'lint', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'on', serverId: 'server', target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 }] };
    const context = { machineId: 'machine-1', machinePlatform: 'posix' as const, directory: '/repo', projectKey: null, agentId: 'codex' };
    const resolved = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true });
    const entries = projectManagedMcpPreviewEntriesV1(projectManagedMcpSelectionV1(resolved, { settings, context }));
    producerPreview = SpawnCapabilitiesPreviewSuccessV1Schema.parse({ ok: true, machinePlatform: 'posix',
        mcp: { strictMode: false, items: resolved.mcp.items.map(({ effectiveConfig: _config, ...item }) => ({ ...item, preview: entries.find(entry => entry.serverId === item.id) })),
            detected: [{ key: 'native', name: 'native-server', transport: 'stdio', authMode: 'unknown', selected: true, selectable: false,
                availability: 'readOnly', sourceKind: 'detected', scopeKind: 'providerUser', provider: 'codex', enabled: true,
                envKeyCount: 0, headerKeyCount: 0, sourcePath: '/home/user/.codex/config.toml' }] },
        skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
        applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } });
    rpc.mockResolvedValue(producerPreview);
});
afterEach(async () => { await standardCleanup(); await homes.reset(); });

function useChip(portableOnly = false) {
    const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
    return useNewSessionMcpSelection({ selectedMachineId: portableOnly ? null : 'machine-1', selectedPath: '/repo',
        portableOnly, agentType: 'codex', targetServerId: serverId, capabilitySelection: selection,
        setCapabilitySelection: setSelection, onOpenSettings: () => {} });
}
function content(chip: ReturnType<typeof useChip>['mcpChip']) {
    const node = chip?.collapsedContentPopover?.renderContent({ requestClose: () => {}, maxHeight: 420 });
    if (!React.isValidElement<NewSessionMcpSelectionContentProps>(node)) throw new Error('Missing MCP content');
    return node.props;
}

describe('incumbent MCP chip Action adapter', () => {
    it('loads only after intent, preserves detected-only counts, and carries draft selection to the Action', async () => {
        const hook = await renderHook(() => useChip());
        expect(rpc).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().mcpChip?.onIntent?.(); await flushHookEffects(); });
        await vi.waitFor(() => expect(hook.getCurrent().mcpPreview?.detected).toHaveLength(1));
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId,
            payload: expect.objectContaining({ directory: '/repo', agentId: 'codex', capabilitySelection: {} }) }));
        expect(content(hook.getCurrent().mcpChip)).toMatchObject({ preview: { managed: [{ serverId: 'server' }] }, maxHeight: 420 });
        await act(async () => { content(hook.getCurrent().mcpChip).onSelectionChange({ mcp: {
            v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: ['server'] } }); });
        expect(content(hook.getCurrent().mcpChip).selection.mcp?.forceExcludeServerIds).toEqual(['server']);
    });
    it('keeps the portable picker available before the temporary Machine exists', async () => {
        const hook = await renderHook(() => useChip(true));
        expect(content(hook.getCurrent().mcpChip)).toMatchObject({ hasContext: true, portableOnly: true });
        expect(rpc).not.toHaveBeenCalled();
    });
    it('refuses incomplete legacy rendering detail without dropping real items or replacing the last-known projection', async () => {
        const hook = await renderHook(() => useChip());
        await act(async () => { hook.getCurrent().mcpChip?.onIntent?.(); await flushHookEffects(); });
        await vi.waitFor(() => expect(hook.getCurrent().mcpPreview?.managed).toHaveLength(1));
        const lastKnown = hook.getCurrent().mcpPreview;
        rpc.mockResolvedValue(SpawnCapabilitiesPreviewSuccessV1Schema.parse({ ...producerPreview, mcp: { ...producerPreview.mcp,
            items: producerPreview.mcp.items.map(({ preview: _legacy, ...item }) => item) } }));
        await act(async () => { await content(hook.getCurrent().mcpChip).onRefresh(); });
        expect(content(hook.getCurrent().mcpChip).error).toBe('invalid_action_output');
        expect(hook.getCurrent().mcpPreview).toBe(lastKnown);
    });
    it('shows the strict invalid-input result for an older preview method while the picker remains usable', async () => {
        rpc.mockRejectedValue(createRpcCallError({ error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const hook = await renderHook(() => useChip());
        await act(async () => { hook.getCurrent().mcpChip?.onIntent?.(); await flushHookEffects(); });
        await vi.waitFor(() => expect(content(hook.getCurrent().mcpChip).error).toBe('invalid_input'));
        expect(content(hook.getCurrent().mcpChip)).toMatchObject({ preview: null, previewUnsupported: false });
    });
});
