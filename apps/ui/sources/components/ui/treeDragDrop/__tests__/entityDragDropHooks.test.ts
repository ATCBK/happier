import { createElement, Fragment, useLayoutEffect } from 'react';
import { expect, it } from 'vitest';
import { createRenderCommitCounter, renderHook, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import { useEntityDragPointer, useEntityDragSource, useEntityDropTarget, useEntityDropTargetState } from '../entityDragDropHooks';
import type { EntityDragDropRuntime } from '../entityDragDropTypes';
import { act } from 'react-test-renderer';
import { useEntityDragChooser } from '../useEntityDragChooser';

type Counter = ReturnType<typeof createRenderCommitCounter>;
function RowFeedbackProbe(props: { runtime: EntityDragDropRuntime; id: string; counter: Counter }) {
    useEntityDragChooser(props.runtime, props.id);
    useEntityDropTargetState(props.runtime, props.id);
    useRenderCommitCounter(props.counter);
    return null;
}
function PointerFeedbackProbe(props: { runtime: EntityDragDropRuntime; counter: Counter }) {
    useEntityDragPointer(props.runtime);
    useRenderCommitCounter(props.counter);
    return null;
}

it('keeps 50 source/target feedback leaves and closed choosers quiet over same-place pointer frames', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    const rows = Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, counter: createRenderCommitCounter() }));
    const pointer = createRenderCommitCounter();
    let enumerations = 0;
    for (const [index, row] of rows.entries()) {
        runtime.registerSource({ id: row.id, scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: row.id } }) });
        runtime.registerTarget({ id: row.id, scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: index * 100, y: 0, width: 100, height: 100 }),
            listDestinations: () => { enumerations++; return []; },
            resolve: () => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: {}, preview: { verb: 'Open', target: row.id } } }),
            execute: async () => ({ status: 'applied' }) });
    }
    const screen = await renderScreen(createElement(Fragment, null,
        rows.map(row => createElement(RowFeedbackProbe, { key: row.id, ...row, runtime })),
        createElement(PointerFeedbackProbe, { runtime, counter: pointer })));
    try {
        act(() => { runtime.begin('row-49')!.move({ x: 10, y: 50 }); });
        for (const row of rows) row.counter.reset();
        pointer.reset();
        for (let frame = 0; frame < 100; frame++) act(() => { runtime.move({ x: 11 + frame % 80, y: 50 }); });
        expect(rows.map(row => row.counter.read())).toEqual(rows.map(() => ({ renders: 0, commits: 0 })));
        expect(pointer.read()).toEqual({ renders: 100, commits: 100 });
        expect(enumerations).toBe(0);
        act(() => { runtime.move({ x: 150, y: 50 }); });
        expect(rows.map(row => row.counter.read().commits)).toEqual(rows.map((_, index) => index < 2 ? 1 : 0));
    } finally { act(() => { runtime.cancel(); }); await screen.unmount(); }
});

it('keeps Mention in composer unavailable when no composer is mounted', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account' };
    runtime.registerSource({ id: 'workflow', scope, isCurrent: () => true,
        getItem: () => ({ kind: 'workflow', scope, workflowId: 'review' }) });
    const hook = await renderHook(() => useEntityDragChooser(runtime, 'workflow'));
    act(() => hook.getCurrent().onOpenChange(true));
    expect(hook.getCurrent().destinations).toContainEqual(expect.objectContaining({
        admission: expect.objectContaining({ status: 'refused', reason: expect.objectContaining({ code: 'composerUnavailable' }) }),
    }));
    expect(await hook.getCurrent().select(hook.getCurrent().destinations[0])).toBeNull();
    expect(runtime.getSnapshot().phase).toBe('carrying');
    act(() => hook.getCurrent().onOpenChange(false));
    expect(runtime.getSnapshot().phase).toBe('idle');
});

it('mounted descriptors read the latest source identity and optional semantic destinations', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account-a' };
    const hook = await renderHook(({ title, enumerate }: { title: string; enumerate: boolean }) => {
        useEntityDragSource(runtime, { id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'child' } }),
            describe: () => ({ title }) });
        useEntityDropTarget(runtime, { id: 'target', scope, acceptedKinds: ['session'], getBounds: () => null,
            listDestinations: enumerate ? () => [{ destination: { title }, label: title }] : undefined,
            resolve: ({ destination }) => ({ status: 'allowed', effect: { actionId: 'session.manager.set',
                input: { destination }, preview: { verb: 'Put under', target: title } } }),
            execute: async () => ({ status: 'applied' }) });
    }, { initialProps: { title: 'First', enumerate: true } });
    expect(runtime.describeSource('source')).toEqual({ title: 'First' });
    expect(runtime.getDestinations('source')[0]).toMatchObject({ destination: { title: 'First' }, label: 'First' });
    await hook.rerender({ title: 'Latest', enumerate: true });
    expect(runtime.describeSource('source')).toEqual({ title: 'Latest' });
    expect(runtime.getDestinations('source')[0]).toMatchObject({ destination: { title: 'Latest' }, label: 'Latest' });
    await hook.rerender({ title: 'Latest', enumerate: false });
    expect(runtime.getDestinations('source')[0]).toEqual({ targetId: 'target', admission: {
        status: 'allowed', effect: { actionId: 'session.manager.set', input: { destination: null },
            preview: { verb: 'Put under', target: 'Latest' } },
    } });
});

it('a target retargeted to another Account cannot execute before passive registration cleanup', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account-a' };
    const effects: unknown[] = [];
    runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
        getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'child' } }) });
    let released: ReturnType<typeof runtime.release> | undefined;
    const hook = await renderHook(({ accountId, releaseDuringLayout }: { accountId: string; releaseDuringLayout: boolean }) => {
        useEntityDropTarget(runtime, { id: 'target', scope: { ...scope, accountId }, acceptedKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'session.manager.set', input: {}, preview: { verb: 'Put under', target: 'Lead' } } }),
            execute: async effect => { effects.push(effect); return { status: 'applied' }; } });
        useLayoutEffect(() => { if (releaseDuringLayout) released = runtime.release(); }, [releaseDuringLayout]);
    }, { initialProps: { accountId: scope.accountId, releaseDuringLayout: false } });
    const carry = runtime.begin('source')!;
    carry.move({ x: 25, y: 25 });
    await hook.rerender({ accountId: 'account-b', releaseDuringLayout: true });
    expect(await released).toBeNull();
    expect(effects).toEqual([]);
});
