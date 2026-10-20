/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

import { useEscapeTakesControl } from './useEscapeTakesControl';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Menu(props: Readonly<{ onClose: () => void }>) {
  useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.popover,
    allowEditableTarget: true,
    onEscape: () => {
      props.onClose();
    },
  });
  return null;
}

function Viewer(
  props: Readonly<{
    menuOpen: boolean;
    onClose: () => void;
    takeControl: () => void;
  }>,
) {
  useEscapeTakesControl(true, props.takeControl);
  return (
    <>
      <button data-testid="outside" />
      <div data-happier-floating-frame="true">
        <button data-testid="frame-chrome" />
      </div>
      {props.menuOpen ? <Menu onClose={props.onClose} /> : null}
    </>
  );
}

describe('useEscapeTakesControl', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  afterEach(async () => {
    await act(async () => root.render(null));
  });
  const press = (testId: string) =>
    container
      .querySelector(`[data-testid="${testId}"]`)!
      .dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );

  it('lets an open menu take Escape first, and takes control only when nothing else claims it', async () => {
    const takeControl = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <Viewer menuOpen onClose={onClose} takeControl={takeControl} />,
      ),
    );
    press('outside');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(takeControl).not.toHaveBeenCalled();

    await act(async () =>
      root.render(
        <Viewer menuOpen={false} onClose={onClose} takeControl={takeControl} />,
      ),
    );
    press('outside');
    expect(takeControl).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape inside the floating frame chrome to the frame', async () => {
    const takeControl = vi.fn();
    await act(async () =>
      root.render(
        <Viewer
          menuOpen={false}
          onClose={() => {}}
          takeControl={takeControl}
        />,
      ),
    );
    press('frame-chrome');
    expect(takeControl).not.toHaveBeenCalled();
  });
});
