import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SessionSystemRecordStoredSchema, tryWriteServerEnabledBitInPlace, ApprovalRequestV2Schema,
  ActionApprovalRequestCreatedResultSchema, type SessionSystemRecordStored } from '@happier-dev/protocol';
import { SessionBoardMutationV1Schema, SessionBoardMutationResultV1Schema } from '@happier-dev/protocol/sessions/board';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionEffectiveAccessV1Schema } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

import { makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createSessionSystemRecordHttpFixture,
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionBoardContinuityProvider } from '@/components/sessions/board/SessionBoardContinuity';
import { SessionBoardControllerOwner } from '@/components/sessions/board/SessionBoardControllerProvider';
import {
  resolveSessionBoardHostVisibility,
  resolveSessionBoardItemPrimaryMountHost,
  type SessionBoardPlacementPrimaryMountResolver,
} from '@/components/sessions/board/sessionBoardHostVisibility';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import {
  createSessionBoardActionsPort,
  projectSessionBoard,
} from '@/sync/domains/session/board';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { BrowserFrameEngineConfig } from '@/components/browser/frame/types';

import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
// The physical browser frame is the only substituted boundary: transcript demand, the
// controller, primary-mount resolution, the widget host and the hosted adapter stay real.
const frames = vi.hoisted(() => ({ active: 0, maximum: 0 }));
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
  BrowserViewFrame: (props: Readonly<{ engine: BrowserFrameEngineConfig }>) => {
    // An unavailable/error renderer is not a live HTML body.
    expect(props.engine).toMatchObject({ kind: 'webIframe', html: expect.any(String) });
    React.useEffect(() => {
      frames.active += 1;
      frames.maximum = Math.max(frames.maximum, frames.active);
      return () => {
        frames.active -= 1;
      };
    }, []);
    return React.createElement('BrowserViewFrame');
  },
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
// The shell's renderer-presence answer: this client can mount caller HTML.
const available = () => ({ kind: 'available' as const });
const pluginRuntime = {
  pluginUiProjection: null,
  pluginBrowserProjection: null,
  phase: 'unavailable' as const,
  interactionEnabled: false,
  machineId: null,
  accountLifetime: null,
  serverId: 'unused',
  platform: 'web' as const,
};
// A desktop shell with no Board host on screen: Details closed, no Board sidebar, no Companion rail.
const noBoardOnScreen = resolveSessionBoardHostVisibility({
  foreground: true,
  panes: {
    detailsOpen: false,
    detailsFocusModeActive: false,
    rightOpen: false,
    rightActiveTabId: null,
  },
  companionPlacement: { kind: 'hidden' },
  mobileSurface: null,
});
const shellResolver: SessionBoardPlacementPrimaryMountResolver = (
  itemId,
  destination,
  boardView,
) =>
  resolveSessionBoardItemPrimaryMountHost({
    visibility: noBoardOnScreen,
    itemVisibleInCompanion: false,
    itemId,
    ...(destination ? { detailsDestination: destination } : {}),
    ...(boardView ? { boardView } : {}),
  });

async function prepare(height: Readonly<Record<string, string>>, viewer: 'owner' | 'view' = 'view') {
  // The browser's Location is the platform boundary; runtime admission and its request controller stay real.
  vi.stubGlobal('location', { origin: 'https://app.example.test', href: 'https://app.example.test/' });
  const item = {
    v: 1,
    destination: 'transcript',
    title: 'Experiment',
    frame: 'frameless',
    height,
    source: {
      kind: 'hostedHtml',
      source: artifactHtmlBundleFromBodyV1('<main>Live result</main>'),
    },
  };
  const record = SessionSystemRecordStoredSchema.parse({
    id: 'visual-record',
    address: {
      owner: 'host',
      namespace: 'surface',
      kind: 'item.v1',
      localId: 'visual',
    },
    content: { t: 'plain', v: item },
    revision,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  });
  const records: SessionSystemRecordStored[] = [SessionSystemRecordStoredSchema.parse({
    ...record, id: 'layout-record', address: { ...record.address, kind: 'layout.v1', localId: 'layout' },
    content: { t: 'plain', v: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] } },
  })];
  const boundary = {
    sessionId: 'session-1',
    records,
    effectiveAccess: SessionEffectiveAccessV1Schema.parse({
      v: 1,
      level: 'owner',
      sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: true,
        grants: [],
      }),
    }),
  };
  const fixture = createSessionSystemRecordHttpFixture(boundary);
  const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'reader', encryptionMode: 'plain' });
  const requests: string[] = [];
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature declaration');
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://inline-live.test',
    serverIdentityId: 'srv_inline-live',
    accountId: 'reader',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}${new URL(String(url)).search}`);
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
      if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (new URL(String(url)).pathname === '/v2/sessions/session-1/board' && init?.method === 'PUT') {
        const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
        if (mutation.operation === 'update_layout') {
          const layoutIndex = records.findIndex(row => row.address.kind === 'layout.v1');
          records[layoutIndex] = SessionSystemRecordStoredSchema.parse({ ...records[layoutIndex], content: mutation.layoutContent });
          return Response.json(SessionBoardMutationResultV1Schema.parse({ operation: mutation.operation,
            outcome: 'updated', layoutRevision: record.revision }));
        }
        if (mutation.operation !== 'upsert_item') throw new Error('Expected the visual publication mutation');
        records.push(SessionSystemRecordStoredSchema.parse({ ...record, content: mutation.itemContent }));
        return Response.json(SessionBoardMutationResultV1Schema.parse({ operation: mutation.operation,
          itemId: mutation.itemId, outcome: 'created', itemRevision: record.revision }));
      }
      return await artifacts.handle(`${path}${new URL(String(url)).search}`, init) ?? fixture.request(url);
    },
  });
  onTestFinished(async () => {
    standardCleanup();
    await connection.dispose();
    vi.unstubAllGlobals();
  });
  primeServerFeaturesSnapshot({ serverId: connection.home.id, snapshot: { status: 'ready', features } });
  const actionInput = getActionSpec('session.board.item.upsert').inputSchema.parse({ sessionId: 'session-1',
    itemId: 'visual', expectedItemRevision: null, destination: 'transcript', item });
  const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
  const executed = await createDefaultActionExecutor().execute('session.board.item.upsert', actionInput,
    { serverId: connection.home.id, surface: 'ui', authority: 'present_user' });
  expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true });
  if (!executed.ok) throw new Error(`Visual publication failed: ${executed.errorCode}`);
  const approval = ActionApprovalRequestCreatedResultSchema.parse(executed.result);
  expect(records.some(row => row.address.kind === 'item.v1')).toBe(false);
  const decision = await decideApprovalAsInbox(connection.home.id, approval.artifactId, 'approve');
  expect(decision, JSON.stringify({ approval: artifacts.readPlainBody(approval.artifactId), requests })).toMatchObject({
    ok: true, result: { status: 'executed' },
  });
  const settled = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approval.artifactId) ?? 'null'));
  if (settled.execution?.ok !== true) throw new Error('The published visual must have an approved execution result');
  const acknowledged = getActionSpec('session.board.item.upsert').outputSchema.parse(settled.execution.result);
  if (viewer === 'view') boundary.effectiveAccess = SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'view',
    sources: [{ kind: 'direct', shareId: 'reader-grant' }], capabilities: projectSessionAccessCapabilitiesV1({
      owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }],
    }) });
  const session = storage.getState().sessions['session-1'];
  if (!session) throw new Error('The published Session must be hydrated before reader admission');
  storage.getState().applySessions([{ ...session, access: createSessionAccessFixture(viewer) }]);
  const tool = makeToolCall({
    name: 'session_board_item_upsert',
    state: 'completed',
    input: actionInput,
    result: acknowledged,
  });
  return { tool, serverId: connection.home.id, records, artifacts, executor: createDefaultActionExecutor() };
}

/** One Session shell with the transcript repeating the same acknowledged visual in two replies. */
function Transcript(
  props: Readonly<{
    tool: ToolCall;
    serverId: string;
    demand: readonly [boolean, boolean];
    canEdit?: boolean;
    actions?: ReturnType<typeof createSessionBoardActionsPort>;
  }>,
) {
  const address = React.useMemo(
    () => ({ serverId: props.serverId, sessionId: 'session-1' }),
    [props.serverId],
  );
  const callerRuntime = useSessionCallerHostedHtmlRuntime(props.serverId, 'session-1', pluginRuntime);
  const binding = React.useMemo(
    () => ({
      status: 'ready' as const,
      snapshot: projectSessionBoard({
        layout: {
          revision,
          outcome: {
            status: 'ready',
            value: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] },
          },
        },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: props.canEdit === true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
      } satisfies Parameters<typeof projectSessionBoard>[0]),
    }),
    [props.canEdit],
  );
  const actions = React.useMemo(
    () => props.actions ?? createSessionBoardActionsPort(address),
    [address, props.actions],
  );
  return (
    <SessionBoardContinuityProvider
      sessionId={address.sessionId}
      serverId={address.serverId}
    >
      <SessionBoardControllerOwner
        address={address}
        input={{ ...address, binding, actions, resolveSourceAvailability: available }}
        binding={binding}
        actions={actions}
        pluginRuntime={{ ...pluginRuntime, serverId: address.serverId }}
        callerHostedHtmlRuntime={callerRuntime}
        resolvePrimaryHost={shellResolver}
      >
        <View testID="reply-1">
          <SessionBoardActionResultReference
            tool={props.tool}
            serverId={props.serverId}
            sessionId="session-1"
            contentDemand={props.demand[0]}
          />
        </View>
        <View testID="reply-2">
          <SessionBoardActionResultReference
            tool={props.tool}
            serverId={props.serverId}
            sessionId="session-1"
            contentDemand={props.demand[1]}
          />
        </View>
      </SessionBoardControllerOwner>
    </SessionBoardContinuityProvider>
  );
}

describe('live inline transcript visuals', () => {
  it('runs one live body for a transcript visual and hands it to the reply still on screen', async () => {
    frames.active = 0;
    frames.maximum = 0;
    const { tool, serverId } = await prepare({
      mode: 'auto',
      fallback: 'regular',
    });
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, true]} />,
    );
    const framesIn = (testID: string) =>
      screen.tree.root
        .findAll((node) => node.props.testID === testID)
        .at(0)!
        .findAll((node) => String(node.type) === 'BrowserViewFrame').length;

    // Keep cold SDK transformation outside the frame assertion's polling budget,
    // while exercising the real async preparation and React publication path.
    await act(async () => { await loadPluginUiHostSupport(); });
    // The transcript is the only host drawing it, so a reply runs it live, and only one does.
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(frames.active).toBe(1);
    });
    expect(framesIn('reply-1')).toBe(1);
    expect(framesIn('reply-2')).toBe(0);
    // The other reply says where the visual runs instead of drawing an empty card.
    expect(
      screen.findByTestId('transcript-board-widget-visual-elsewhere'),
    ).not.toBeNull();

    // The live reply scrolls away: its body is released and the reply still on screen takes it.
    await screen.update(
      <Transcript tool={tool} serverId={serverId} demand={[false, true]} />,
    );
    await vi.waitFor(async () => {
      await act(async () => { await Promise.resolve(); });
      expect(framesIn('reply-2')).toBe(1);
    });
    expect(frames.active).toBe(1);
    expect(frames.maximum).toBe(1);

    await act(async () => {
      await screen.update(
        <Transcript tool={tool} serverId={serverId} demand={[false, false]} />,
      );
    });
    expect(frames.active).toBe(0);
  });

  it("sizes a reply by the item's declared height, not a transcript-local clamp", async () => {
    const { tool, serverId } = await prepare({ mode: 'fixed', size: 'tall' });
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]} />,
    );
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('transcript-board-widget-visual-body'),
      ).not.toBeNull(),
    );
    const body = screen.findByTestId('transcript-board-widget-visual-body')!;
    const style = Object.assign(
      {},
      ...[body.props.style].flat(Infinity).filter(Boolean),
    ) as { height?: number };
    // `tall` is the item's declared size; the old transcript bounds capped every visual at 320.
    expect(style.height).toBe(440);
  });

  it('pins a transcript visual to the Board as the same item, through the existing layout operation', async () => {
    const { tool, serverId, records, artifacts, executor } = await prepare({ mode: 'auto', fallback: 'regular' }, 'owner');
    const address = { serverId, sessionId: 'session-1' };
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const actions = createSessionBoardActionsPort({ ...address, execute: createFrontDoorActionExecute(executor) });
    const itemBefore = records.find(row => row.address.kind === 'item.v1');
    const screen = await renderScreen(
      <Transcript tool={tool} serverId={serverId} demand={[true, false]} canEdit actions={actions} />,
    );
    const readPin = () => screen.tree.root.findAllByType(ItemRowActions)
      .find((node) => node.props.overflowTriggerTestID === 'transcript-board-widget-visual-actions')
      ?.props.actions.find((action: { id: string }) => action.id === 'pin-to-board');
    await vi.waitFor(() => expect(readPin()).toBeTruthy());
    const priorApprovals = new Set(artifacts.list().map(row => row.id));
    await act(async () => { readPin()?.onPress?.(); });
    await vi.waitFor(() => expect(artifacts.list().some(row => !priorApprovals.has(row.id))).toBe(true));
    const approvalId = artifacts.list().find(row => !priorApprovals.has(row.id))!.id;
    expect(await decideApprovalAsInbox(serverId, approvalId, 'approve')).toMatchObject({ ok: true, result: { status: 'executed' } });
    await vi.waitFor(() => expect(records.find(row => row.address.kind === 'layout.v1')?.content).toMatchObject({
      t: 'plain', v: { tabs: [{ id: 'view-a', items: [{ itemId: 'visual' }] }] },
    }));
    expect(records.filter(row => row.address.kind === 'item.v1')).toEqual([itemBefore]);
  });
});
