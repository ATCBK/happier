import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, readWidgetSurfaceArtifactV1, projectOverviewDefaultPlacementsV1, flattenWidgetLayoutWidgetsV1, WidgetAreaLayoutV1Schema, WIDGET_SURFACE_ARTIFACT_KIND_V1, type WidgetAreaLayoutV1 } from '@happier-dev/protocol/widgets';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
import { createWidgetCatalogActionDepsV1 } from './widgetCatalogActionDeps';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
// Match the application entry before Account restoration; real owner initialization belongs to collection.
import '@/sync/syncEngine';

it('admits local and portable Home identities through the widget Action owner without admitting another Home', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://widget-identity.test',
        serverIdentityId: 'srv_0123456789abcdefghijklmnopqrstuv', accountId: 'actor' });
    const account = await captureLazyActionAccountContext(connection.home.id);
    const surface = { serverId: connection.home.id, accountId: 'actor',
        owner: { kind: 'project' as const, projectId: 'identity-project' } };
    const boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: value => buildWidgetSurfaceArtifactHeaderV1(value),
    });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(boundary.request);
    try {
        const area = createWidgetAreaActionDepsV1(account);
        const deps = createActionExecutorBoundaryFixture(area);
        const executor = createActionExecutor({ ...deps, ...createWidgetCatalogActionDepsV1(account, deps) });
        const context = { surface: 'ui' as const, serverId: connection.home.id, serverIdentityId: 'srv_0123456789abcdefghijklmnopqrstuv' };
        expect(await executor.execute('widgets.item.list', { surface }, context))
            .toMatchObject({ ok: true, result: { surface } });
        const portableSurface = { ...surface, serverId: context.serverIdentityId };
        expect(await executor.execute('widgets.item.list', { surface: portableSurface }, context))
            .toMatchObject({ ok: true, result: { surface: portableSurface } });
        expect(await executor.execute('widgets.item.list', { surface: { ...surface, serverId: 'srv-other' } }, context))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(await executor.execute('widgets.item.list', { surface }, { ...context, serverIdentityId: 'srv-other' }))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(boundary.writes).toHaveLength(0);
    } finally { account.dispose(); await connection.dispose(); }
});

it('uses a stable Project key without a Source through the actual Account Artifact codec', async () => {
    const produced: { header: Readonly<Record<string, unknown>>; body: string }[] = [];
    const provisional = { serverId: 'home', accountId: 'actor', owner: { kind: 'project' as const, projectId: 'stable-project' } };
    let surface = provisional;
    let boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://source-free-dashboard.test', accountId: 'actor', request: async (url, init) => {
        if (init?.method === 'POST' && new URL(String(url)).pathname.startsWith('/v1/artifacts')) {
            const wire: unknown = JSON.parse(String(init.body));
            if (!wire || typeof wire !== 'object') throw new Error('Expected Artifact mutation');
            const header = z.record(z.string(), StrictJsonValueSchema).parse(decodePlainArtifactStoredContent(String(Reflect.get(wire, 'header'))));
            const body = decodePlainArtifactStoredContent(String(Reflect.get(wire, 'body')));
            if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected Artifact text body');
            const text = String(Reflect.get(body, 'body'));
            produced.push({ header, body: text });
        }
        return boundary.request(url, init);
    } });
    surface = { ...provisional, serverId: connection.home.id };
    const checkout = WorkspaceRefV1WriteSchema.parse({ id: 'checkout', serverId: surface.serverId,
        machineId: 'machine', rootPath: '/repo', projectKey: surface.owner.projectId, createdAtMs: 1 });
    boundary = createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('actor', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1 as const, surface, items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
    });
    // The checkout is admitted against the Account's Project rows, never against page context alone.
    boundary.setWorkspaceRefs([checkout]);
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: connection.home.id,
            expectedAccountId: 'actor', actionCaller: { kind: 'host' as const },
            widgetAreaContext: { surface, values: { checkout: [checkout] } },
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
                'widgets.item.add': ['ui'], 'widgets.item.rename': ['ui'],
            } }),
        };
        const defaults = projectOverviewDefaultPlacementsV1();
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: {
            surface, state: 'missing', canEdit: true, instances: defaults.map(({ kind: _kind, ...entry }) => entry) } });
        expect(boundary.writes).toHaveLength(0);
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_about' },
            bindings: { checkout: { kind: 'value' as const, value: checkout } } };
        const added = await executor.execute('widgets.item.add', { surface, instance }, context);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        const saved = flattenWidgetLayoutWidgetsV1(boundary.layout().items);
        expect(saved.filter(entry => entry.instance.id !== instance.id).map(entry => ({ id: entry.instance.id, area: entry.area })))
            .toEqual(defaults.map(entry => ({ id: entry.instance.id, area: entry.area })));
        // The retained preset is not the person's frame choice: each widget keeps following its area's default.
        expect(saved.filter(entry => entry.instance.id !== instance.id).map(entry => entry.frameStyle ?? null))
            .toEqual(defaults.map(() => null));
        expect(saved.find(entry => entry.instance.id === instance.id)).toMatchObject({ instance, area: 'main' });
        expect(await executor.execute('widgets.item.rename', { ref: { surface, instanceId: instance.id }, displayName: 'My project' }, context))
            .toMatchObject({ ok: true });
        expect(flattenWidgetLayoutWidgetsV1(boundary.layout().items).find(entry => entry.instance.id === instance.id)?.instance.displayName).toBe('My project');
        expect(produced.length).toBeGreaterThan(0);
        for (const wire of produced) {
            const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(wire.body));
            // Assert outside HTTP: the Action's unknown-outcome projection must
            // not swallow a producer/consumer assertion thrown by the boundary.
            expect(readWidgetSurfaceArtifactV1({ artifactId: boundary.artifactId, ...wire })).toEqual(layout);
            expect(wire.header).toMatchObject(buildWidgetSurfaceArtifactHeaderV1(layout));
        }
        expect(await executor.execute('widgets.item.list', { surface: { ...surface, accountId: 'foreign' } }, context))
            .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    } finally { account.dispose(); await connection.dispose(); }
});

it('opens and edits one explicitly attached owner dashboard through the recipient Artifact admission', async () => {
    let surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project' as const, projectId: 'stable-project', layoutId: 'notes' } };
    const makeBoundary = () => createLayoutArtifactHttpBoundary<WidgetAreaLayoutV1>('owner', {
        artifactId: buildWidgetSurfaceArtifactIdV1(surface), kind: WIDGET_SURFACE_ARTIFACT_KIND_V1,
        defaultLayout: { v: 1, surface, name: 'Notes', items: [] }, parseLayout: value => WidgetAreaLayoutV1Schema.parse(value),
        buildHeader: value => buildWidgetSurfaceArtifactHeaderV1(value),
    });
    let boundary = makeBoundary();
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://shared-dashboard.test', accountId: 'viewer', request: (...args) => boundary.request(...args) });
    surface = { ...surface, serverId: connection.home.id }; boundary = makeBoundary();
    boundary.seed({ v: 1, surface, name: 'Notes', items: [{ kind: 'widget', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'project_about' }, bindings: {} } }] });
    boundary.setCallerAccess('view');
    const selected = { ...surface, artifactId: boundary.artifactId };
    const account = await captureLazyActionAccountContext(connection.home.id);
    try {
        const port = createWidgetAreaActionDepsV1(account).widgetSurfaceActions!.project!;
        expect(await port.read(selected, { surface: 'ui' })).toMatchObject({ surface: selected, canEdit: false, isShared: true });
        expect(await port.apply(selected, { kind: 'rename', instanceId: 'copy', displayName: 'Not permitted' }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'artifact_access_forbidden' });
        expect(boundary.writes).toHaveLength(0);
        boundary.setCallerAccess('edit');
        expect(await port.apply(selected, { kind: 'rename', instanceId: 'copy', displayName: 'Recipient edit' }, { surface: 'ui' }))
            .toMatchObject({ ok: true });
        expect(boundary.layout()).toMatchObject({ surface, items: [{ kind: 'widget', instance: { displayName: 'Recipient edit' } }] });
        expect(await port.read(surface, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'widget_area_owner_mismatch' });
    } finally { account.dispose(); await connection.dispose(); }
});
