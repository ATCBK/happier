import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';

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
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import {
  createSessionBoardActionsPort,
  projectSessionBoard,
} from '@/sync/domains/session/board';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { SessionBoardActionsPort } from '@/sync/domains/session/board/sessionBoardActionsPort';
import type { BrowserFrameEngineConfig } from '@/components/browser/frame/types';

import { SessionBoardActionResultReference } from './SessionBoardActionResultReference';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';

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
const callerRuntime: CallerHostedHtmlRuntime = {
  serverIdentityId: 'home-1',
  accountId: 'alice',
  accountEncryptionMode: 'plain',
  hostOrigin: 'https://app.example.test',
  admittedHostMethods: [],
  createRequestController: () => ({
    handleRequest: async () => null,
    dispose: () => {},
  }),
  lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) },
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

async function prepare(height: Readonly<Record<string, string>>) {
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
  const fixture = createSessionSystemRecordHttpFixture({
    sessionId: 'session-1',
    records: [record],
    effectiveAccess: {
      v: 1,
      level: 'view',
      sources: [{ kind: 'direct', shareId: 'reader-grant' }],
      capabilities: projectSessionAccessCapabilitiesV1({
        owner: false,
        grants: [{ accessLevel: 'view', canApprovePermissions: false }],
      }),
    },
  });
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://inline-live.test',
    accountId: 'reader',
    request: fixture.request,
  });
  onTestFinished(async () => {
    standardCleanup();
    await connection.dispose();
  });
  const tool = makeToolCall({
    name: 'session_board_item_upsert',
    state: 'completed',
    input: {
      itemId: 'visual',
      expectedItemRevision: null,
      destination: 'transcript',
      item,
    },
    result: {
      v: 1,
      serverId: connection.home.id,
      sessionId: 'session-1',
      result: {
        operation: 'upsert_item',
        itemId: 'visual',
        outcome: 'created',
        itemRevision: revision,
      },
      destination: null,
      itemDestination: 'transcript',
    },
  });
  return { tool, serverId: connection.home.id };
}

/** One Session shell with the transcript repeating the same acknowledged visual in two replies. */
function Transcript(
  props: Readonly<{
    tool: ToolCall;
    serverId: string;
    demand: readonly [boolean, boolean];
  }>,
) {
  const address = React.useMemo(
    () => ({ serverId: props.serverId, sessionId: 'session-1' }),
    [props.serverId],
  );
  const binding = React.useMemo(
    () => ({
      status: 'ready' as const,
      snapshot: projectSessionBoard({
        layout: {
          revision: 'ssr1:layout',
          outcome: {
            status: 'ready',
            value: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] },
          },
        },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: false },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
      } as Parameters<typeof projectSessionBoard>[0]),
    }),
    [],
  );
  const actions = React.useMemo(
    () => createSessionBoardActionsPort(address),
    [address],
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
    const { tool, serverId } = await prepare({ mode: 'auto', fallback: 'regular' });
    const address = { serverId, sessionId: 'session-1' };
    const layoutUpdates: Parameters<SessionBoardActionsPort['updateLayout']>[0][] = [];
    const unavailable = { status: 'unavailable' as const, reason: 'board_actions_unavailable' as const };
    // The Board mutation transport is the boundary; the controller and its command path stay real.
    const actions: SessionBoardActionsPort = {
      upsertItem: async () => unavailable,
      removeItem: async () => unavailable,
      updateLayout: async (input) => { layoutUpdates.push(input); return unavailable; },
    };
    const binding = {
      status: 'ready' as const,
      snapshot: projectSessionBoard({
        layout: { revision: 'ssr1:layout', outcome: { status: 'ready', value: { v: 1, tabs: [{ id: 'view-a', title: 'A', items: [] }] } } },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
      } as Parameters<typeof projectSessionBoard>[0]),
    };
    const screen = await renderScreen(
      <SessionBoardContinuityProvider sessionId={address.sessionId} serverId={address.serverId}>
        <SessionBoardControllerOwner address={address}
          input={{ ...address, binding, actions, resolveSourceAvailability: available }}
          binding={binding} actions={actions}
          pluginRuntime={{ ...pluginRuntime, serverId }} callerHostedHtmlRuntime={callerRuntime}
          resolvePrimaryHost={shellResolver}>
          <SessionBoardActionResultReference tool={tool} serverId={serverId} sessionId="session-1" contentDemand />
        </SessionBoardControllerOwner>
      </SessionBoardContinuityProvider>,
    );
    const readPin = () => screen.tree.root.findAllByType(ItemRowActions)
      .find((node) => node.props.overflowTriggerTestID === 'transcript-board-widget-visual-actions')
      ?.props.actions.find((action: { id: string }) => action.id === 'pin-to-board');
    await vi.waitFor(() => expect(readPin()).toBeTruthy());
    await act(async () => { readPin()?.onPress?.(); });
    await vi.waitFor(() => expect(layoutUpdates).toHaveLength(1));
    // A placement for the SAME item: no item write, no copy.
    expect(layoutUpdates[0]).toMatchObject({ sessionId: 'session-1', operation: { op: 'item.place', itemId: 'visual', tabId: 'view-a' } });
  });
});
