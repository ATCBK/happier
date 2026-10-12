import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  createSessionSurfaceNoteDocumentV1,
  type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { renderScreen } from '@/dev/testkit';
import type { SessionBoardItemProjection } from '@/sync/domains/session/board';

import {
  SessionWidgetHost,
  type SessionWidgetHostProps,
} from './SessionWidgetHost';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
  const { createGestureHandlerMock } =
    await import('@/dev/testkit/mocks/gestureHandler');
  return createGestureHandlerMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    useActiveServerAccountScope: () => ({
      serverId: 'home-1',
      accountId: 'account-1',
    }),
  });
});

/**
 * The copies a visual offers from its ⋯ menu. Every visual, typed or HTML, becomes a widget through
 * one entry; a second "Add to…" that opens the same panel from another host is a duplicate.
 */

function itemOf(
  source: SessionSurfaceItemV1['source'],
): SessionBoardItemProjection {
  return {
    itemId: 'visual-1',
    revision: 'rev-1',
    state: {
      kind: 'ready',
      item: {
        v: 1,
        title: 'Build time by package',
        frame: 'frameless',
        height: { mode: 'auto', fallback: 'regular' },
        source,
      } as SessionSurfaceItemV1,
    },
  };
}

async function menuIds(
  item: SessionBoardItemProjection,
): Promise<readonly string[]> {
  const props = {
    sessionId: 'session-1',
    serverId: 'home-1',
    item,
    host: 'inlineTranscript',
    primaryHost: null,
    density: 'compact',
    frame: 'reply',
    canEdit: false,
    executableCurrentness: 'not_executable',
    testID: 'widget',
  } as SessionWidgetHostProps;
  const screen = await renderScreen(<SessionWidgetHost {...props} />);
  const owners = screen.root.findAll(
    (node) =>
      Array.isArray((node.props as { actions?: unknown }).actions) &&
      (node.props as { overflowTriggerTestID?: string })
        .overflowTriggerTestID === 'widget-actions',
  );
  const actions =
    (
      owners.at(-1)?.props as
        | { actions: ReadonlyArray<{ id: string }> }
        | undefined
    )?.actions ?? [];
  return actions.map((action) => action.id);
}

describe('a visual’s copies in its ⋯ menu', () => {
  it('offers native builtin promotion and sharing alongside reading', async () => {
    const ids = await menuIds(itemOf({ kind: 'widget', instance: { v: 1, id: 'visual-1',
      definition: { kind: 'builtin', id: 'usage_daily' }, bindings: {} } }));
    expect(ids).toContain('saveAsYours');
    expect(ids).toContain('shareVisual');
    expect(ids).toContain('addTo');
    expect(ids).toContain('about');
  });
  it('makes a typed visual a widget through one entry', async () => {
    const ids = await menuIds(
      itemOf({
        kind: 'declarative',
        document: createSessionSurfaceNoteDocumentV1('Body'),
      }),
    );
    expect(
      ids.filter((id) => id === 'saveAsYours' || id === 'addVisualTo'),
    ).toEqual(['saveAsYours']);
    expect(ids).toContain('shareVisual');
  });

  it('makes an HTML visual a widget through the same entry, beside Save as Artifact and Share', async () => {
    const html = {
      v: 1,
      entrypoint: 'index.html',
      files: {
        'index.html': { mime: 'text/html', contentBase64: 'PGI+aGk8L2I+' },
      },
    };
    const ids = await menuIds(
      itemOf({
        kind: 'hostedHtml',
        source: html,
      } as SessionSurfaceItemV1['source']),
    );
    expect(
      ids.filter((id) => id === 'saveAsYours' || id === 'addVisualTo'),
    ).toEqual(['saveAsYours']);
    expect(ids).toEqual(
      expect.arrayContaining(['saveArtifact', 'shareVisual']),
    );
  });
});
