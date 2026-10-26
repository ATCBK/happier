import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

import {
  isSessionViewerPresenting,
  useOptionalSessionViewerController,
  useSessionViewerComposerReserve,
  type SessionViewerController,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import {
  SESSION_VIEWER_EDGE,
  SESSION_VIEWER_PHONE_RESERVE,
  SESSION_VIEWER_STATE_MIN_BODY,
} from './sessionViewerGeometry';

function mountController(
  input: Readonly<{ phone: boolean; computer?: boolean; serverId?: string | null }>,
) {
  const openDocked = vi.fn();
  const canPresentSource = (source: 'computer' | 'browser') =>
    source === 'browser' || input.computer !== false;
  function Wrapper(props: React.PropsWithChildren) {
    return (
      <SessionViewerControllerProvider
        sessionId="session-a"
        serverId={input.serverId === undefined ? 'home-a' : input.serverId}
        phone={input.phone}
        canPresentSource={canPresentSource}
        openDocked={openDocked}
      >
        {props.children}
      </SessionViewerControllerProvider>
    );
  }
  return {
    openDocked,
    render: () =>
      renderHook(
        () => ({
          controller: useOptionalSessionViewerController()!,
          composerReserve: useSessionViewerComposerReserve(),
        }),
        { wrapper: Wrapper },
      ),
  };
}

describe('SessionViewerController', () => {
  it('refuses semantic ingress without an exact Home and after the mounted owner retires', async () => {
    const { render } = mountController({ phone: false, serverId: null });
    const hook = await render();
    const request = hook.getCurrent().controller.requestSemantic;
    expect(request).toBeTypeOf('function');
    await expect(request({ kind: 'viewer.open', source: 'computer' })).resolves.toMatchObject({
      ok: false, errorCode: 'current_session_presentation_not_current',
    });
    expect(hook.getCurrent().controller.state.mode).toBe('closed');
    await hook.unmount();
    await expect(request({ kind: 'viewer.close' })).resolves.toMatchObject({
      ok: false, errorCode: 'current_session_presentation_not_current',
    });
  });
  it('opens floating on desktop through the mounted semantic port and docks into the pane presentation locally', async () => {
    const { render, openDocked } = mountController({ phone: false });
    const hook = await render();
    let result!: ReturnType<SessionViewerController['apply']>;
    await act(async () => {
      result = hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(result).toEqual({ status: 'applied' });
    expect(hook.getCurrent().controller.state).toMatchObject({
      source: 'computer',
      mode: 'floating',
    });
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'computer'),
    ).toBe(true);
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'browser'),
    ).toBe(false);

    await act(async () => {
      result = hook.getCurrent().controller.apply({ kind: 'viewer.dock' });
    });
    expect(result).toEqual({ status: 'applied' });
    expect(openDocked).toHaveBeenCalledWith('computer');
    // Docked on desktop: the pane presents the same body, so the viewer no longer does.
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'computer'),
    ).toBe(false);

    // Watch again while docked reveals the pane presentation instead of doing nothing.
    await act(async () => {
      result = hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(result).toEqual({ status: 'unchanged' });
    expect(openDocked).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  it('docks sticky on a phone, expands and restores to the dock, and keeps Close closed', async () => {
    const { render, openDocked } = mountController({ phone: true });
    const hook = await render();
    await act(async () => {
      hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'browser' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('docked');
    expect(
      isSessionViewerPresenting(hook.getCurrent().controller, 'browser'),
    ).toBe(true);
    expect(isSessionViewerPresenting(hook.getCurrent().controller, 'browser', true)).toBe(false);
    expect(isSessionViewerPresenting(hook.getCurrent().controller, 'browser', false)).toBe(true);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.expand' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('expanded');
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.restore' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('docked');
    // Corner/size stay desktop-local geometry.
    expect(
      hook
        .getCurrent()
        .controller.apply({ kind: 'viewer.corner.set', corner: 'tl' }),
    ).toEqual({ status: 'unavailable' });
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.close' });
    });
    expect(hook.getCurrent().controller.state.mode).toBe('closed');
    // The phone's dock is the reading flow of Chat: opening reveals it, nothing else does.
    expect(openDocked).toHaveBeenCalledTimes(1);
    expect(openDocked).toHaveBeenCalledWith('browser');
    await hook.unmount();
  });

  it('holds room above the composer for a phone viewer, docked or expanded, so the attention band yields to it', async () => {
    // The reserve holds a whole state card (the least frame the viewer is legible in) plus its gutters.
    expect(SESSION_VIEWER_PHONE_RESERVE).toBeGreaterThan(SESSION_VIEWER_STATE_MIN_BODY + SESSION_VIEWER_EDGE * 2);
    const phone = mountController({ phone: true });
    const hook = await phone.render();
    expect(hook.getCurrent().composerReserve).toBe(0);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(hook.getCurrent().composerReserve).toBe(SESSION_VIEWER_PHONE_RESERVE);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.expand' });
    });
    expect(hook.getCurrent().composerReserve).toBe(SESSION_VIEWER_PHONE_RESERVE);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.close' });
    });
    expect(hook.getCurrent().composerReserve).toBe(0);
    await hook.unmount();

    // A desktop frame floats beside the reading column; the composer keeps its whole budget.
    const desktop = mountController({ phone: false });
    const wide = await desktop.render();
    await act(async () => {
      wide.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(wide.getCurrent().controller.state.mode).toBe('floating');
    expect(wide.getCurrent().composerReserve).toBe(0);
    await wide.unmount();
  });

  it('reveals the phone dock on every open request, including one for the source already docked', async () => {
    const { render, openDocked } = mountController({ phone: true });
    const hook = await render();
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(openDocked).toHaveBeenLastCalledWith('computer');
    await act(async () => {
      expect(hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'unchanged' });
    });
    expect(openDocked).toHaveBeenCalledTimes(2);
    await act(async () => {
      hook.getCurrent().controller.port.apply({ kind: 'viewer.close' });
    });
    expect(openDocked).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  it('keeps an open viewer presented across desktop and phone reflow without losing its desktop geometry', async () => {
    const input = { phone: false };
    const { render, openDocked } = mountController(input);
    const hook = await render();
    const rect = { x: 600, y: 200, width: 320, height: 200 };
    try {
      await act(async () => {
        hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' });
        hook.getCurrent().controller.setRect(rect);
      });
      input.phone = true;
      await hook.rerender();
      expect(hook.getCurrent().controller.state).toMatchObject({ source: 'computer', mode: 'docked' });
      expect(isSessionViewerPresenting(hook.getCurrent().controller, 'computer')).toBe(true);
      input.phone = false;
      await hook.rerender();
      expect(hook.getCurrent().controller.state).toMatchObject({ source: 'computer', mode: 'floating', rect });
      await act(async () => { hook.getCurrent().controller.port.apply({ kind: 'viewer.expand' }); });
      input.phone = true;
      await hook.rerender();
      expect(hook.getCurrent().controller.state.mode).toBe('expanded');
      await act(async () => { hook.getCurrent().controller.port.apply({ kind: 'viewer.close' }); });
      input.phone = false;
      await hook.rerender();
      input.phone = true;
      await hook.rerender();
      expect(hook.getCurrent().controller.state.mode).toBe('closed');
      expect(openDocked).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
  });

  it('refuses a source the Session cannot present without changing what is shown', async () => {
    const { render } = mountController({ phone: false, computer: false });
    const hook = await render();
    let result!: ReturnType<SessionViewerController['apply']>;
    await act(async () => {
      result = hook
        .getCurrent()
        .controller.port.apply({ kind: 'viewer.open', source: 'computer' });
    });
    expect(result).toEqual({ status: 'unavailable' });
    expect(hook.getCurrent().controller.state.mode).toBe('closed');
    await hook.unmount();
  });

  it('reveals the desktop pane when a geometry-docked viewer returns from phone reflow', async () => {
    const input = { phone: false };
    const { render, openDocked } = mountController(input);
    const hook = await render();
    try {
      await act(async () => {
        hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' });
        hook.getCurrent().controller.apply({ kind: 'viewer.dock' });
      });
      input.phone = true;
      await hook.rerender();
      openDocked.mockClear();
      input.phone = false;
      await hook.rerender();
      expect(hook.getCurrent().controller.state.mode).toBe('docked');
      expect(openDocked).toHaveBeenCalledWith('computer');
      openDocked.mockClear();
      await hook.rerender();
      expect(openDocked).not.toHaveBeenCalled();
      await act(async () => { hook.getCurrent().controller.port.apply({ kind: 'viewer.close' }); });
      input.phone = true;
      await hook.rerender();
      input.phone = false;
      await hook.rerender();
      expect(hook.getCurrent().controller.state.mode).toBe('closed');
      expect(openDocked).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
  });

  it('docks only on the person\'s Dock and floats again on request, with no placement verdict in between', async () => {
    const { render, openDocked } = mountController({ phone: false });
    const hook = await render();
    try {
      await act(async () => { hook.getCurrent().controller.port.apply({ kind: 'viewer.open', source: 'computer' }); });
      await act(async () => { hook.getCurrent().controller.apply({ kind: 'viewer.dock' }); });
      expect(hook.getCurrent().controller.state).toMatchObject({ mode: 'docked', restore: null });
      expect(openDocked).toHaveBeenCalledWith('computer');
      let result: ReturnType<SessionViewerController['apply']> | undefined;
      await act(async () => { result = hook.getCurrent().controller.apply({ kind: 'viewer.float' }); });
      expect(result).toEqual({ status: 'applied' });
      expect(hook.getCurrent().controller.state.mode).toBe('floating');
    } finally { await hook.unmount(); }
  });
});
