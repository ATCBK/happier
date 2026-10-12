import { expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, flattenWidgetLayoutWidgetsV1, WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { HomeHubArtifactV1, HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { useWidgetAreaLayout, type WidgetAreaPort } from './useWidgetAreaLayout';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

it('distinguishes a pending observation from retired Account authority and rejects its late completion', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://area-pending-retirement.test', accountId: 'actor' });
    const surface: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'work' } };
    let delayed = false;
    let release: (() => void) | undefined;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => { if (delayed) await new Promise<void>(resolve => { release = resolve; }); return null; },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true, presets: [{ id: 'work', name: 'Work', items: [] }] });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        const retained = hook.getCurrent().state;
        if (retained.status !== 'ready') throw new Error('Expected admitted layout');
        delayed = true;
        context = {};
        await hook.rerender();
        expect(retained.isReadPending()).toBe(true);
        expect(retained.isCurrent()).toBe(true);
        retireActiveServerAccountScopeLifetime();
        expect(retained.isCurrent()).toBe(false);
        expect(retained.isReadPending()).toBe(false);
        expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Retired' }))
            .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
        await act(async () => { delayed = false; release?.(); });
        await flushHookEffects();
        expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable', reasonCode: 'widget_area_scope_retired' });
    } finally { await hook.unmount(); await connection.dispose(); }
});

it('projects core-page preset groups and first-edit personalization through the shared area read', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            const row = rows.get(input.artifactId)!;
            if (row.revision.bodyVersion !== input.expectedRevision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const next = { ...row, body: input.body, header: input.header, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            rows.set(input.artifactId, next); return { ok: true, revision: next.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true, presets: [{
        id: 'overview', name: 'Overview', items: [{ kind: 'group', id: 'group', children: [
            { kind: 'widget', instance: { v: 1, id: 'child', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } },
        ] }],
    }] });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'missing', preset: { isEdited: false },
        items: [{ kind: 'group', id: 'group', frameStyle: 'card', dividers: 'hairline' }], placements: [{ instance: { id: 'child' } }] });
    expect(rows.size).toBe(0);
    await owner.apply({ kind: 'rename', instanceId: 'group', displayName: 'Mine' });
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'present', preset: { isEdited: true }, items: [{ title: 'Mine' }] });
    const reset = await owner.resetPreset();
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ preset: { isEdited: false } });
    await owner.undoReset(reset.undo!);
    context = {};
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ preset: { isEdited: true }, items: [{ title: 'Mine' }] });
    await hook.unmount();
});

it('exposes missing versus present-empty and current admitted dashboard identity without creating a layout', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'anchor' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 2, bodyVersion: 2 } };
            rows.set(input.artifactId, row); return { ok: true, revision: row.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) }) };
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    const missing = hook.getCurrent().state;
    expect(missing).toMatchObject({ status: 'ready', documentState: 'missing' });
    if (missing.status === 'ready') expect(missing.placements).toHaveLength(7);
    expect(rows.size).toBe(0);
    expect(missing.status === 'ready' && missing.isCurrent()).toBe(true);
    const instance = { v: 1 as const, id: 'explicit', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} };
    await owner.apply({ kind: 'add', instance, area: 'aside' });
    await owner.apply({ kind: 'remove', instanceId: instance.id });
    for (const entry of flattenWidgetLayoutWidgetsV1((await owner.read()).items)) await owner.apply({ kind: 'remove', instanceId: entry.instance.id });
    context = {};
    await hook.rerender();
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', documentState: 'present', placements: [],
        dashboard: { name: 'Overview', ownerAccountId: 'actor', access: 'owner' } });
    expect(rows.size).toBe(1);
    await hook.unmount();
});

it('settles an acknowledged widget add even when its follow-up layout read is still pending', async () => {
    const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'actor', owner: { kind: 'project', projectId: 'anchor' } };
    const rows = new Map<string, HomeHubArtifactV1>();
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row);
            return row;
        },
        update: async input => {
            const row = rows.get(input.artifactId)!;
            if (row.revision.bodyVersion !== input.expectedRevision.bodyVersion) return { ok: false, errorCode: 'version_mismatch', error: 'version_mismatch' };
            const next = { ...row, body: input.body, header: input.header, revision: { headerVersion: row.revision.headerVersion + 1, bodyVersion: row.revision.bodyVersion + 1 } };
            rows.set(input.artifactId, next);
            return { ok: true, revision: next.revision };
        },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    let listReads = 0;
    const port: WidgetAreaPort = { execute: async (operation) => {
        if (operation.actionId === 'widgets.item.list') {
            listReads += 1;
            if (listReads > 1) await new Promise<never>(() => {});
            return PluginUiWidgetAreaResultV1Schema.parse({ ok: true, result: await area.read(surface, {}) });
        }
        if (operation.actionId !== 'widgets.item.add') throw new Error('Unexpected operation');
        return PluginUiWidgetAreaResultV1Schema.parse(await area.apply(surface, {
            kind: 'add',
            instance: operation.instance,
            ...(operation.area ? { area: operation.area } : {}),
            ...(operation.size ? { size: operation.size } : {}),
        }, {}));
    } };
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    let settled: unknown;
    void hook.getCurrent().write({
        actionId: 'widgets.item.add',
        instance: { v: 1, id: 'added', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} },
        area: 'aside',
    }).then(outcome => { settled = outcome; });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(settled).toEqual({ kind: 'applied' });
    // Observing another read is not a terminal fact about the still-authorized layout.
    const retained = hook.getCurrent().state;
    expect(retained.status === 'ready' && retained.isCurrent()).toBe(true);
    expect(rows.size).toBe(1);
    await hook.unmount();
});

it('withdraws mounted effect admission on exact Artifact publication before a delayed reread settles', async () => {
    const storedSurface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'owner',
        owner: { kind: 'project', projectId: 'anchor', layoutId: 'named' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(storedSurface);
    const surface = { ...storedSurface, artifactId };
    const layout = { v: 1 as const, surface: storedSurface, items: [] } satisfies WidgetAreaLayoutV1;
    const row: HomeHubArtifactV1 = { artifactId, ownerAccountId: 'owner', access: 'view',
        header: buildWidgetSurfaceArtifactHeaderV1(layout), revision: { headerVersion: 1, bodyVersion: 1 },
        body: JSON.stringify(layout) };
    const publication = { id: artifactId, title: 'Named', isDecrypted: true as const, ownerAccountId: 'owner', access: 'view' as const,
        storageMode: 'plain' as const, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    let revoked = false;
    let releaseRead: (() => void) | undefined;
    let waitForRead = false;
    const transport: HomeHubArtifactTransportV1 = {
        read: async () => {
            if (waitForRead) await new Promise<void>(resolve => { releaseRead = resolve; });
            if (!revoked) storage.getState().applyArtifacts([{ ...publication }]);
            return revoked ? null : row;
        },
        create: async () => { throw new Error('Unexpected create'); },
        update: async () => { throw new Error('Unexpected update'); },
    };
    const owner = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    const area = createWidgetAreaActionPortV1(() => owner);
    const port: WidgetAreaPort = { execute: async () => {
        const result = await area.read(surface, {});
        return PluginUiWidgetAreaResultV1Schema.parse('ok' in result ? result : { ok: true, result });
    } };
    const context = {};
    storage.getState().deleteArtifact(artifactId);
    expect(storage.getState().artifacts[artifactId]).toBeUndefined();
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    const admitted = hook.getCurrent().state;
    expect(admitted.status).toBe('ready');
    if (admitted.status !== 'ready') throw new Error('Expected admitted attached surface');
    expect(admitted.isCurrent()).toBe(true); // Initial publication settles through the existing exact-row reconciliation.
    const firstPublication = storage.getState().artifacts[artifactId];
    waitForRead = true;
    publication.updatedAt = 2;
    await act(async () => storage.getState().applyArtifacts([{ ...publication }]));
    expect(admitted.isCurrent()).toBe(false);
    expect(admitted.isReadPending()).toBe(true);
    expect(hook.getCurrent().state.status).toBe('ready'); // Last admitted layout remains during the read.
    await act(async () => { waitForRead = false; releaseRead?.(); });
    await flushHookEffects();
    const renewed = hook.getCurrent().state;
    if (renewed.status !== 'ready') throw new Error('Expected read to renew admission');
    expect(renewed.isCurrent()).toBe(true);
    expect(renewed.isReadPending()).toBe(false);
    expect(storage.getState().artifacts[artifactId]).not.toBe(firstPublication);
    waitForRead = true;
    revoked = true;
    await act(async () => storage.getState().deleteArtifact(artifactId));
    expect(renewed.isCurrent()).toBe(false);
    await act(async () => { waitForRead = false; releaseRead?.(); });
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'unavailable' });
    await hook.unmount();
});

it('keeps the newly selected area when an earlier captured durable write acknowledges late', async () => {
    const surface = (pageId: string): WidgetSurfaceRefV1 => ({ serverId: 'home', accountId: 'actor', owner: { kind: 'pluginArea', pluginId: 'acme', pageId, area: 'main' } });
    const first = surface('first'); const second = surface('second');
    const rows = new Map<string, HomeHubArtifactV1>();
    let releaseWrite: (() => void) | undefined;
    let enteredWrite: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredWrite = resolve; });
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async input => {
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 1, bodyVersion: 1 } };
            rows.set(input.artifactId, row); return row;
        },
        update: async input => {
            enteredWrite?.();
            await new Promise<void>(resolve => { releaseWrite = resolve; });
            const row = { ...input, ownerAccountId: 'actor', access: 'owner' as const, revision: { headerVersion: 2, bodyVersion: 2 } };
            rows.set(input.artifactId, row); return { ok: true, revision: row.revision };
        },
    };
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const bind = (ref: WidgetSurfaceRefV1): WidgetAreaPort => ({ execute: async (operation, signal) => {
        const result = operation.actionId === 'widgets.item.list'
            ? { ok: true, result: await area.read(ref, { surface: 'ui' }, signal) }
            : operation.actionId === 'widgets.item.rename'
                ? await area.apply(ref, { kind: 'rename', instanceId: operation.instanceId, displayName: operation.displayName }, { surface: 'ui' }, signal)
                : (() => { throw new Error('Unsupported fixture operation'); })();
        return PluginUiWidgetAreaResultV1Schema.parse(result);
    } });
    const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
    const firstLayout = { v: 1 as const, surface: first, items: [{ kind: 'group', id: 'group', width: 'full',
        frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }] }] } satisfies WidgetAreaLayoutV1;
    rows.set(buildWidgetSurfaceArtifactIdV1(first), { artifactId: buildWidgetSurfaceArtifactIdV1(first), ownerAccountId: 'actor', access: 'owner',
        header: buildWidgetSurfaceArtifactHeaderV1(firstLayout), body: JSON.stringify(firstLayout), revision: { headerVersion: 1, bodyVersion: 1 } });
    let port = bind(first);
    let context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'copy' } }] });
    const retiredWrite = hook.getCurrent().write;
    let pending: Promise<unknown> | undefined;
    await act(async () => { pending = hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Updated old area' }); await entered; });
    port = bind(second);
    context = {};
    await hook.rerender();
    await flushHookEffects();
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: second });
    expect(await retiredWrite({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Retired callback' }))
        .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
    await act(async () => { releaseWrite?.(); await pending; });
    expect(JSON.parse(String(rows.get(buildWidgetSurfaceArtifactIdV1(first))?.body))).toMatchObject({ items: [{ kind: 'group',
        children: [{ kind: 'widget', instance: { displayName: 'Updated old area' } }] }] });
    expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: second });
    const unmountedWrite = hook.getCurrent().write;
    await hook.unmount();
    expect(await unmountedWrite({ actionId: 'widgets.item.rename', instanceId: 'copy', displayName: 'Unmounted callback' }))
        .toEqual({ kind: 'refused', errorCode: 'widget_area_unavailable' });
});

it('writes the displayed Artifact rather than the newly selected same-id copy while its read is pending', async () => {
    const surface = (layoutId: string): WidgetSurfaceRefV1 => ({ serverId: 'home', accountId: 'actor', owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId } });
    const first = surface('first'); const second = surface('second');
    const rows = new Map<string, HomeHubArtifactV1>();
    const seed = (ref: WidgetSurfaceRefV1, displayName: string) => {
        const layout: WidgetAreaLayoutV1 = { v: 1, surface: ref, items: [{ kind: 'widget', instance: { v: 1, id: 'same-id',
            definition: { kind: 'builtin', id: 'project_about' }, bindings: {}, displayName } }] };
        rows.set(buildWidgetSurfaceArtifactIdV1(ref), { artifactId: buildWidgetSurfaceArtifactIdV1(ref), ownerAccountId: 'actor', access: 'owner',
            header: buildWidgetSurfaceArtifactHeaderV1(layout), body: JSON.stringify(layout), revision: { headerVersion: 1, bodyVersion: 1 } });
    };
    seed(first, 'Displayed'); seed(second, 'Selected');
    let blockNextRead = false;
    let release: (() => void) | undefined;
    const transport: HomeHubArtifactTransportV1 = {
        read: async id => rows.get(id) ?? null,
        create: async () => { throw new Error('Unexpected create'); },
        update: async input => { const prior = rows.get(input.artifactId)!;
            const revision = { headerVersion: prior.revision.headerVersion + 1, bodyVersion: prior.revision.bodyVersion + 1 };
            rows.set(input.artifactId, { ...prior, ...input, revision }); return { ok: true, revision }; },
    };
    const area = createWidgetAreaActionPortV1(ref => createWidgetSurfaceArtifactPortV1(transport, { surface: ref, isCurrent: () => true }));
    const pendingRead = new Promise<void>(resolve => { release = resolve; });
    const bind = (ref: WidgetSurfaceRefV1): WidgetAreaPort => ({ execute: async (operation, signal, target) => {
        const selected = target?.surface ?? ref;
        if (operation.actionId === 'widgets.item.list' && selected === second && blockNextRead) await pendingRead;
        const result = operation.actionId === 'widgets.item.list' ? { ok: true, result: await area.read(selected, {}, signal) }
            : operation.actionId === 'widgets.item.rename' ? await area.apply(selected, { kind: 'rename', instanceId: operation.instanceId, displayName: operation.displayName }, {}, signal)
            : (() => { throw new Error('Unsupported operation'); })();
        return PluginUiWidgetAreaResultV1Schema.parse(result);
    } });
    let port = bind(first);
    const context = {};
    const hook = await renderHook(() => useWidgetAreaLayout(port, context));
    try {
        await flushHookEffects();
        blockNextRead = true;
        port = bind(second);
        await hook.rerender();
        expect(hook.getCurrent().state).toMatchObject({ status: 'ready', surface: first });
        await act(async () => { expect(await hook.getCurrent().write({ actionId: 'widgets.item.rename', instanceId: 'same-id', displayName: 'Edited displayed' })).toEqual({ kind: 'applied' }); });
        const displayedBody = rows.get(buildWidgetSurfaceArtifactIdV1(first))?.body;
        const selectedBody = rows.get(buildWidgetSurfaceArtifactIdV1(second))?.body;
        if (typeof displayedBody !== 'string' || typeof selectedBody !== 'string') throw new Error('Expected both stored layout bodies');
        const displayed = WidgetAreaLayoutV1Schema.parse(JSON.parse(displayedBody));
        const selected = WidgetAreaLayoutV1Schema.parse(JSON.parse(selectedBody));
        expect(flattenWidgetLayoutWidgetsV1(displayed.items)[0]!.instance.displayName).toBe('Edited displayed');
        expect(flattenWidgetLayoutWidgetsV1(selected.items)[0]!.instance.displayName).toBe('Selected');
    } finally { await act(async () => { release?.(); }); await hook.unmount(); }
});
