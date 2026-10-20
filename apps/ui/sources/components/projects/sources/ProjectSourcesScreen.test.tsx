import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Install the external Socket boundary before the screen loads Sync for Account restoration.
await vi.hoisted(async () => {
  const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
  installDisconnectedServerSocketBoundary();
});

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1, WidgetAreaLayoutV1Schema } from '@happier-dev/protocol/widgets';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Action front door is this screen's boundary: Source reads and writes are Actions whose host
 * (membership, revision CAS, storage) lives outside the page. The fake records each call and answers
 * the catalog; the screen, its controller, the address parser and the editor below it are real.
 */
const shared = vi.hoisted(() => ({
  calls: [] as Array<{ actionId: string; input: any }>,
  sources: [] as unknown[],
  routes: { params: {} as Record<string, string> },
  navigation: [] as unknown[],
  createOutcomes: [] as Array<'unknown'>,
  artifacts: {} as Record<string, unknown>,
  confirm: vi.fn(async () => false),
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
  createFrontDoorActionExecute: () => async (actionId: string, input: any) => {
    shared.calls.push({ actionId, input });
    if (actionId === 'projects.sources.list')
      return {
        ok: true,
        result: {
          ok: true,
          sources: shared.sources,
          coverage: { complete: true, nextCursor: null },
        },
      };
    if (actionId === 'projects.sources.read') {
      const source = shared.sources.find(
        (row: any) => row.id === input.sourceId,
      );
      return {
        ok: true,
        result: source
          ? { ok: true, source, canManage: true }
          : { ok: false, error: 'source_unavailable' },
      };
    }
    if (actionId === 'scm.hostingRepository.resolveAddress')
      return {
        ok: true,
        result: {
          success: true,
          kind: 'resolved',
          selector: {
            provider: {
              id: 'happier.scm.forge.github/github',
              kind: 'github',
              displayName: 'GitHub',
              baseUrl: 'https://github.com',
            },
            repository: { nameWithOwner: 'acme/billing' },
            protocol: 'https',
          },
        },
      };
    if (actionId === 'projects.sources.create' && shared.createOutcomes.shift() === 'unknown')
      return { ok: false, errorCode: 'outcome_unknown' };
    if (actionId === 'projects.sources.create') {
      // The real create answers the canonical Source row, never the request's idempotency key.
      const { serverId: _serverId, requestKey: _requestKey, ...fields } = input;
      const source = {
        id: 'created',
        revision: 1,
        audience: [],
        createdByAccountId: 'account-1',
        ...fields,
      };
      shared.sources = [...shared.sources, source];
      return { ok: true, result: { ok: true, source, canManage: true } };
    }
    if (actionId === 'projects.sources.delete') {
      shared.sources = shared.sources.filter((row: any) => row.id !== input.sourceId);
      return { ok: true, result: { ok: true, sourceId: input.sourceId, revision: input.expectedRevision + 1 } };
    }
    return { ok: true, result: {} };
  },
}));

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    params: () => shared.routes.params,
    router: {
      push: (value: unknown) => {
        shared.navigation.push(value);
      },
      replace: (value: unknown) => {
        shared.navigation.push(value);
      },
    },
  }).module;
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm: shared.confirm } }).module;
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

const { ProjectSourcesScreen } = await import('./ProjectSourcesScreen');
const { storage } = await import('@/sync/domains/state/storageStore');
const previous = storage.getState();
const previousAppliedServer = getAppliedActiveServerSnapshot();
const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();

afterEach(() => {
  standardCleanup();
  storage.setState(previous);
  publishAppliedActiveServerSnapshot(previousAppliedServer, previousRuntimeAvailable);
  shared.calls = [];
  shared.sources = [];
  shared.navigation = [];
  shared.routes.params = {};
  shared.createOutcomes = [];
  shared.confirm.mockClear();
});

function signIn() {
  storage.setState({
    profileScope: { serverId: 'server-1', accountId: 'account-1' },
    // A Machine on this Home answers the address check (the resolver runs where Git runs); the inventory
    // is this Home's settled list, never another Home's.
    machineListByServerId: {
      'server-1': [{ id: 'm1', active: true, activeAt: Date.now(), createdAt: 1, metadata: { host: 'devbox', displayName: 'devbox' } }],
    } as never,
    machineListStatusByServerId: { 'server-1': 'idle' },
  });
  publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://home.test', generation: previousAppliedServer.generation + 1 });
}

describe('Projects › Sources', () => {
  it('renews the mounted catalog exactly once when the same Account lifetime retires', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(1));

    await act(async () => {
      retireActiveServerAccountScopeLifetime();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(2));
    expect(screen.findByTestId('projects.sources.empty')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(shared.calls.filter((call) => call.actionId === 'projects.sources.list')).toHaveLength(2);
  });

  it('routes Delete directly to Action admission without a caller-owned confirmation floor', async () => {
    signIn();
    shared.sources = [{ id: 'source-1', revision: 1, name: 'happier', audience: [], createdByAccountId: 'account-1',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https' } }];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.detail.delete')).toBeTruthy());
    await act(async () => screen.pressByTestId('projects.sources.detail.delete'));
    await vi.waitFor(() => expect(shared.calls.some((call) => call.actionId === 'projects.sources.delete')).toBe(true));
    expect(shared.confirm).not.toHaveBeenCalled();
  });
  it('invites the first Source when the authenticated catalog is empty, and Add opens the draft', async () => {
    signIn();
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.empty')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.empty.add');
    });
    expect(shared.navigation).toContainEqual('/projects/sources?source=new');
  });

  it('saves a new Source from a typed address through the one create Action and selects it', async () => {
    signIn();
    storage.setState({ machineListStatusByServerId: { 'server-1': 'loading' } });
    shared.sources = [
      {
        id: 'existing',
        revision: 1,
        name: 'website',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: {
            id: 'happier.scm.forge.github/github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
          },
          repository: { nameWithOwner: 'happier-dev/website' },
          protocol: 'https',
        },
      },
    ];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('projects.sources.detail.address.field'),
      ).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    expect(field.props.autoComplete).toBe('off');
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    expect(shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress')).toBe(false);
    await act(async () => {
      storage.setState({ machineListStatusByServerId: { 'server-1': 'idle' } });
    });
    await vi.waitFor(() =>
      expect(
        shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress'),
      ).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    const create = shared.calls.find(
      (call) => call.actionId === 'projects.sources.create',
    );
    expect(create?.input).toMatchObject({
      serverId: 'server-1',
      name: 'billing',
      audience: [],
      repository: {
        repository: { nameWithOwner: 'acme/billing' },
        protocol: 'https',
      },
    });
    expect(shared.navigation).toContainEqual(
      '/projects/sources?source=created',
    );
  });

  it('recovers an unconfirmed create only after a complete inspection, retrying the same request', async () => {
    signIn();
    shared.createOutcomes = ['unknown'];
    shared.routes.params = { source: 'new' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.address.field')).toBeTruthy(),
    );
    const field = screen.findByTestId('projects.sources.detail.address.field')!;
    await act(async () => {
      field.props.onChangeText?.('github.com/acme/billing');
    });
    await act(async () => {
      field.props.onBlur?.();
      field.props.onSubmitEditing?.();
    });
    await vi.waitFor(() =>
      expect(shared.calls.some((call) => call.actionId === 'scm.hostingRepository.resolveAddress')).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.save');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown')).toBeTruthy(),
    );
    // Save cannot repeat it yet; the banner's only way forward is to check every Source.
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.detail.outcomeUnknown.action')).toBeTruthy(),
    );
    await act(async () => {
      screen.pressByTestId('projects.sources.detail.outcomeUnknown.action');
    });
    await vi.waitFor(() => expect(shared.calls.filter((call) => call.actionId === 'projects.sources.create')).toHaveLength(2));
    const [first, second] = shared.calls.filter((call) => call.actionId === 'projects.sources.create');
    expect(second!.input.requestKey).toBe(first!.input.requestKey);
    expect(shared.navigation).toContainEqual('/projects/sources?source=created');
  });

  it('never shows a same-id local document for a dashboard attached on another Home', async () => {
    signIn();
    storage.setState({
      projectAccountRows: createProjectAccountRowsFixture({ serverId: 'server-1', accountId: 'account-1' }, {
        workspaceRefs: [{ id: 'checkout-1', serverId: 'server-1', machineId: 'm1', rootPath: '/repo',
          projectKey: 'viewer-project', source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 1 }],
      }),
      artifacts: {
        dash: { id: 'dash', title: 'Local release', isDecrypted: true, access: 'edit' },
      } as never,
    });
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        attachments: [
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash' } },
          { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dash', serverId: 'server-2' } },
        ],
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() =>
      expect(screen.findByTestId('projects.sources.dashboard.server-2:dash')).toBeTruthy(),
    );
    // The outermost match is the row itself (its title/subtitle props); findByTestId prefers the pressable host.
    const local = screen.findAllByTestId('projects.sources.dashboard.server-1:dash')[0]!;
    const foreign = screen.findAllByTestId('projects.sources.dashboard.server-2:dash')[0]!;
    expect(local.props.title).toBe('Local release');
    expect(foreign.props.title).not.toBe('Local release');
    expect(foreign.props.subtitle).toBe('projects.sources.dashboardOtherHome');
    await act(async () => screen.pressByTestId('projects.sources.dashboard.server-1:dash'));
    const href = shared.navigation.at(-1);
    expect(typeof href).toBe('string');
    const url = new URL(String(href), 'https://happier.test');
    expect(url.pathname).toBe('/projects/checkout-1/overview');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ serverId: 'server-1',
      dashboardSourceId: 'source-1', dashboardArtifactId: 'dash' });
    expect(foreign.props.onPress).toBeUndefined();
  });
  it('names each checkout\'s Machine through the machine-name owner, never its raw id', async () => {
    signIn();
    const devbox = storage.getState().machineListByServerId['server-1']![0]!;
    storage.setState({
      machines: { m1: devbox } as never,
      projectAccountRows: createProjectAccountRowsFixture({ serverId: 'server-1', accountId: 'account-1' }, {
        workspaceRefs: [
          { id: 'here', serverId: 'server-1', machineId: 'm1', rootPath: '/repo', projectKey: 'p',
            source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 1 },
          { id: 'gone', serverId: 'server-1', machineId: 'retired-machine-id', rootPath: '/old', projectKey: 'p',
            source: { sourceId: 'source-1', revision: 1 }, createdAtMs: 2 },
        ],
      }),
    });
    shared.sources = [{ id: 'source-1', revision: 1, name: 'happier', audience: [], createdByAccountId: 'account-1',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https' } }];
    shared.routes.params = { source: 'source-1' };
    const screen = await renderScreen(<ProjectSourcesScreen />);
    await vi.waitFor(() => expect(screen.findByTestId('projects.sources.checkout.m1')).toBeTruthy());
    const title = (id: string) => screen.findAllByTestId(id)[0]!.props.title;
    expect(title('projects.sources.checkout.m1')).toBe('devbox');
    expect(title('projects.sources.checkout.retired-machine-id')).toBe('machine.unlistedMachine');
  });

  it('edits the default branch through a field select whose Other entry asks for any ref', async () => {
    signIn();
    shared.sources = [
      {
        id: 'source-1',
        revision: 1,
        name: 'happier',
        audience: [],
        createdByAccountId: 'account-1',
        repository: {
          provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
          repository: { nameWithOwner: 'happier-dev/happier' },
          protocol: 'https',
        },
        defaultRef: 'v0.3',
      },
    ];
    shared.routes.params = { source: 'source-1' };
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { Modal } = await import('@/modal');
    const screen = await renderScreen(<ProjectSourcesScreen />);
    const select = () => screen.findAllByType(DropdownMenu).find((node) => node.props.testID === 'projects.sources.detail.defaultRef');
    await vi.waitFor(() => expect(select()).toBeDefined());
    // The stored ref is the selection; the repository default and Other stay one step away (T1-F8).
    expect(select()!.props.items.map((item: { id: string }) => item.id)).toEqual(['ref:@default', 'ref:v0.3', 'ref:@other']);
    expect(select()!.props.selectedId).toBe('ref:v0.3');
    expect(screen.findByTestId('projects.sources.detail.save')).toBeFalsy();
    vi.mocked(Modal.prompt).mockResolvedValueOnce('develop');
    await act(async () => {
      select()!.props.onSelect('ref:@other');
    });
    await vi.waitFor(() => expect(select()!.props.selectedId).toBe('ref:develop'));
    expect(screen.findByTestId('projects.sources.detail.save')).toBeTruthy();
  });
  it('opens the independently admitted foreign dashboard and retains its Home in the exact checkout route', async () => {
    const homes = await serveAccountHomes({ homes: [
      { key: 'foreign', serverUrl: 'https://rf10-source-foreign.example', accountId: 'foreign-viewer' },
      { key: 'source', serverUrl: 'https://rf10-source-local.example', accountId: 'source-viewer' },
    ], route: request => request.home === 'foreign' ? document.request(request.url, { method: request.method, headers: request.headers }) : undefined });
    const serverId = homes.homes.source!.id;
    const disconnect = await homes.restoreActiveConnection();
    const foreignHome = homes.homes.foreign!.id;
    const surface = { accountId: 'dashboard-owner', serverId: foreignHome, owner: { kind: 'project' as const, projectId: 'owners-project' } };
    const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
    const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, name: 'Foreign release', items: [] });
    const document = createLayoutArtifactHttpBoundary('dashboard-owner', { artifactId, kind: 'widget-area-layout.v1', defaultLayout: layout,
      parseLayout: value => WidgetAreaLayoutV1Schema.parse(value), buildHeader: buildWidgetSurfaceArtifactHeaderV1 });
    document.seed(layout);
    document.setCallerAccess('view');
    storage.setState({ projectAccountRows: createProjectAccountRowsFixture({ serverId, accountId: 'source-viewer' }, {
      workspaceRefs: [{ id: 'foreign-checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
        projectKey: 'personal-project', source: { sourceId: 'foreign-source', revision: 1 } }],
    }), artifacts: { [artifactId]: { id: artifactId, title: 'Local release', isDecrypted: true, access: 'edit',
      headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
    shared.sources = [{ id: 'foreign-source', revision: 1, name: 'Repository', audience: [], createdByAccountId: 'source-owner',
      repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'owner/repo' }, protocol: 'https' },
      attachments: [{ purpose: 'dashboard', ref: { kind: 'doc', artifactId, serverId: foreignHome } }] }];
    shared.routes.params = { source: 'foreign-source' };
    try {
      const screen = await renderScreen(<ProjectSourcesScreen />);
      const rowId = `projects.sources.dashboard.${foreignHome}:${artifactId}`;
      await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.title).toBe('Foreign release'));
      expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeTypeOf('function');
      await act(async () => screen.pressByTestId(rowId));
      const url = new URL(String(shared.navigation.at(-1)), 'https://happier.test');
      expect(url.pathname).toBe('/projects/foreign-checkout/overview');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ serverId, dashboardSourceId: 'foreign-source',
        dashboardArtifactId: artifactId, dashboardServerId: foreignHome });
      document.setCallerAccess(null);
      await act(async () => publishHomeAccountChange(foreignHome, [artifactId], { changeKinds: ['artifact'] }));
      await vi.waitFor(() => expect(screen.findAllByTestId(rowId)[0]?.props.onPress).toBeUndefined());
      expect(storage.getState().artifacts[artifactId]?.title).toBe('Local release');
      expect(document.writes).toEqual([]);
      expect(homes.requests.filter(request => request.home === 'foreign' && request.path.startsWith('/v1/artifacts'))
        .every(request => request.accountId === 'foreign-viewer')).toBe(true);
    } finally { await disconnect(); await homes.dispose(); }
  });
});
