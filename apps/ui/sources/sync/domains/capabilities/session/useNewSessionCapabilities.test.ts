import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol/mcp/servers/previewV1';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<DaemonMcpServersPreviewResponse>>());
// The real RPC codec and all selection logic run beneath this network transport boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));

describe('useNewSessionCapabilities', () => {
    beforeEach(() => {
        transport.mockReset();
        transport.mockResolvedValue({ ok: true, builtIn: [], managed: [], detected: [] });
    });

    it('updates a draft optimistically without losing the other capability kind and previews only on demand', async () => {
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({
                mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
            });
            return useNewSessionCapabilities({ machineId: 'machine-1', directory: '/repo', agentId: 'codex', enabled: true, selection, setSelection });
        });
        expect(transport).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toMatchObject({ mcp: { forceIncludeServerIds: ['server-a'] }, skills: { forceIncludeSkillIds: ['skill-a'] } });
        const unchanged = hook.getCurrent().selection;
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toBe(unchanged);
        expect(hook.getCurrent().previewStatus).toBe('idle');
        await act(async () => { hook.getCurrent().demandPreview(); await flushHookEffects(); });
        expect(hook.getCurrent().previewStatus).toBe('ready');
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            capabilitySelection: expect.objectContaining({ mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
                skills: expect.objectContaining({ forceIncludeSkillIds: ['skill-a'] }) }),
        }) }));
        expect(hook.getCurrent().lastKnownPreview).toEqual({ ok: true, builtIn: [], managed: [], detected: [] });
        transport.mockRejectedValueOnce(Object.assign(new Error('Machine offline'), { code: 'machine_offline' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('unreachable');
        expect(hook.getCurrent().lastKnownPreview).toEqual({ ok: true, builtIn: [], managed: [], detected: [] });
        transport.mockRejectedValueOnce(Object.assign(new Error('Method not found'), { code: 'RPC_METHOD_NOT_AVAILABLE' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('error');
        expect(hook.getCurrent().lastKnownPreview).not.toBeNull();
    });
});
