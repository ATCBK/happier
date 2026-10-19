import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { applyMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { resetMcpServerCatalogEngineForTests } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
// The mounted public Action endpoint is the system boundary; catalog subscriptions stay real.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({ useMountedActionExecution: () => ({
    execute: boundary.execute, ready: true, isCurrent: () => true, approval: {},
}) }));
const { useReachRules } = await import('./useReachRules');
const scope = { serverId: 'reach-home', accountId: 'reach-account' };
const initial: ReachRuleV1 = { id: 'everywhere', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 };
beforeEach(() => {
    retirePresentationNotice();
    boundary.execute.mockReset();
    getStorage().setState({ settingsScope: scope, profileScope: scope, settings: settingsParse({}) });
    applyMcpServerCatalogSnapshot(scope, { status: 'ready', revision: 1, authority: 'active', diagnostics: [], catalog: {
        v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'server', args: [] },
            env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ ...initial, serverId: 'server' }],
    } }, true);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1,
        record: { key: 'skill-rules', value: { v: 1, rules: [{ ...initial, skillId: 'server' }] } } }],
        tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
});

afterEach(async () => {
    await standardCleanup();
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});
describe.each(['mcp_server', 'skill'] as const)('%s reach rules authoring', kind => {
    const item = (rules: readonly ReachRuleV1[], previous: readonly ReachRuleV1[]) => ({
        [kind === 'skill' ? 'skillId' : 'serverId']: 'server', rules, previous,
    });
    it('reads the approval Home rather than the focused Account', async () => {
        const captured = { serverId: 'approval-home', accountId: 'approval-account' };
        const exception = { ...initial, id: 'approval-exception', agentId: 'gemini', enabled: false };
        if (kind === 'mcp_server') applyMcpServerCatalogSnapshot(captured, { status: 'ready', revision: 1, authority: 'active', diagnostics: [], catalog: {
            v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
            bindings: [{ ...exception, serverId: 'server' }],
        } }, true);
        else applyPromptLibraryCatalogSnapshot(captured, { catalog: { status: 'ready', rows: [{ revision: 1,
            record: { key: 'skill-rules', value: { v: 1, rules: [{ ...exception, skillId: 'server' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const hook = await renderHook(() => useReachRules(kind, 'server', captured));
        expect(hook.getCurrent().rules).toEqual([exception]);
    });
    it('projects a replace immediately and restores the last acknowledged rules on typed refusal', async () => {
        const pending = createDeferred<unknown>();
        boundary.execute.mockReturnValueOnce(pending.promise);
        const hook = await renderHook(() => useReachRules(kind, 'server'));
        expect(hook.getCurrent().status).toBe('ready');
        let write!: ReturnType<ReturnType<typeof useReachRules>['change']>;
        act(() => { write = hook.getCurrent().change({ kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: false }] }); });
        expect(hook.getCurrent().rules[0]?.enabled).toBe(false);
        await act(async () => { pending.resolve({ ok: true, result: { ok: false, code: 'conflict' } }); await write; });
        expect(await write).toEqual({ ok: false, message: 'conflict' });
        expect(hook.getCurrent().rules).toEqual([initial]);
    });
    it('serializes rapid writes from the last written value and Undo resends the returned previous rules', async () => {
        const first = createDeferred<unknown>();
        boundary.execute.mockReturnValueOnce(first.promise);
        const hook = await renderHook(() => useReachRules(kind, 'server'));
        const off = { ...initial, enabled: false, updatedAt: 2 };
        const machine = { id: 'machine', target: { t: 'machine' as const, machineId: 'm1' }, enabled: true, createdAt: 3, updatedAt: 3 };
        boundary.execute.mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 3,
            items: [item([off, machine], [off])] } });
        let one!: Promise<unknown>; let two!: Promise<unknown>;
        act(() => {
            one = hook.getCurrent().change({ kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } });
            two = hook.getCurrent().change({ kind: 'write', write: { place: { t: 'machine', machineId: 'm1' }, state: 'on' } });
        });
        await vi.waitFor(() => expect(boundary.execute).toHaveBeenCalledTimes(1));
        expect(hook.getCurrent().rules.find(rule => rule.target.t === 'allMachines')?.enabled).toBe(false);
        expect(hook.getCurrent().rules.find(rule => rule.target.t === 'machine')?.enabled).toBe(true);
        await act(async () => { first.resolve({ ok: true, result: { ok: true, revision: 2,
            items: [item([off], [initial])] } }); await one; await two; });
        expect(hook.getCurrent().rules).toEqual([off, machine]);
        boundary.execute.mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 4,
            items: [item([off], [off, machine])] } });
        await act(async () => { await hook.getCurrent().undoLast(); });
        expect(boundary.execute.mock.calls.at(-1)).toEqual([kind === 'skill' ? 'skills.rules.set' : 'mcp.rules.set', {
            items: [{ [kind === 'skill' ? 'skillId' : 'serverId']: 'server' }],
            change: { kind: 'replace', rules: [{ target: off.target, enabled: false }] } }]);
        expect(hook.getCurrent().rules).toEqual([off]);
    });
    it('offers notice Undo only after acknowledgement and restores the server-returned previous rules', async () => {
        const pending = createDeferred<unknown>();
        const concurrent = { ...initial, enabled: false, updatedAt: 2 };
        const written = { ...initial, updatedAt: 3 };
        boundary.execute.mockReturnValueOnce(pending.promise);
        const hook = await renderHook(() => useReachRules(kind, 'server'));
        let write!: Promise<unknown>;
        act(() => { write = hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'on' } }); });
        expect(readPresentationNotice()?.undo).toBeUndefined();
        await act(async () => { pending.resolve({ ok: true, result: { ok: true, revision: 3,
            items: [item([written], [concurrent])] } }); await write; });
        boundary.execute.mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 4,
            items: [item([concurrent], [written])] } });
        expect(readPresentationNotice()?.undo).toBeDefined();
        await act(async () => { readPresentationNotice()?.undo?.run(); });
        expect(boundary.execute.mock.calls.at(-1)?.[1]).toEqual({
            items: [{ [kind === 'skill' ? 'skillId' : 'serverId']: 'server' }],
            change: { kind: 'replace', rules: [{ target: initial.target, enabled: false }] } });
    });
    it('keeps an unreadable catalog unavailable rather than presenting an empty ready value', async () => {
        const hook = await renderHook(() => useReachRules(kind, 'server'));
        await act(async () => {
            if (kind === 'mcp_server') applyMcpServerCatalogSnapshot(scope, { status: 'unavailable', reason: 'invalid-stored-content' }, true);
            else applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'partial', rows: [], tombstones: [],
                diagnostics: [{ key: 'skill-rules', revision: 1, reason: 'invalid-stored-content' }] },
                rawSettings: {}, sourceSettingsVersion: 1 }, true);
        });
        expect(hook.getCurrent().status).toBe('unavailable');
        expect(await hook.getCurrent().change({ kind: 'replace', rules: [] })).toEqual({ ok: false, message: 'catalog_unavailable' });
        expect(boundary.execute).not.toHaveBeenCalled();
    });
});
