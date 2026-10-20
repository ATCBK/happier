import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResizableSize, type ResizableSizeInput, type ResizableSizeResult } from './useResizableSize.js';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); vi.unstubAllGlobals(); });

async function mount(options: Partial<ResizableSizeInput> = {}) {
  await act(async () => root?.unmount());
  let current!: ResizableSizeResult;
  const commits = vi.fn();
  const collapsed = vi.fn();
  const armed = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  function Surface() {
    current = useResizableSize({ axis: 'x', resizeEdge: 'end', sizePx: 320, minSizePx: 200, maxSizePx: 480,
      onCommitSizePx: commits, onCollapse: collapsed, onCollapseArmedChange: armed, ...options });
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => { root!.render(<Surface />); });
  await act(async () => { (current.webHandleProps.onPointerDown as (event: unknown) => void)({ clientX: 320 }); });
  const move = async (clientX: number) => { await act(async () => window.dispatchEvent(new MouseEvent('pointermove', { clientX }))); };
  const release = async () => { await act(async () => window.dispatchEvent(new MouseEvent('pointerup'))); };
  const flush = async () => { await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(0)); }); };
  return { commits, collapsed, armed, frames, move, release, flush, read: () => current };
}

describe('shared resize gesture', () => {
  it('uses only the current move for overshoot and collapse, including a reversal before release', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(99);
    await drag.flush();
    expect(drag.armed).toHaveBeenLastCalledWith(true);
    await drag.move(150);
    await drag.release();
    expect(drag.collapsed).not.toHaveBeenCalled();
    expect(drag.commits).toHaveBeenLastCalledWith(200, expect.objectContaining({ attemptedSizePx: 150, collapseArmed: false, exceededMinPx: true }));
    const returned = await mount({ collapse: true });
    await returned.move(99);
    await returned.move(220);
    await returned.release();
    expect(returned.commits).toHaveBeenLastCalledWith(220, expect.objectContaining({ exceededMinPx: false, collapseArmed: false, overshootPx: 0 }));
  });

  it('collapses only when opted in and released strictly past half the minimum', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(100);
    await drag.release();
    expect(drag.collapsed).not.toHaveBeenCalled();
    const armed = await mount({ collapse: true });
    await armed.move(99);
    await armed.release();
    expect(armed.collapsed).toHaveBeenCalledOnce();
    expect(armed.commits).not.toHaveBeenCalled();
    const rail = await mount();
    await rail.move(1);
    await rail.release();
    expect(rail.collapsed).not.toHaveBeenCalled();
    expect(rail.commits).toHaveBeenCalledWith(200, expect.objectContaining({ collapseArmed: false }));
  });

  it('coalesces live sizes to one frame while committing the latest move synchronously', async () => {
    const live = vi.fn();
    const drag = await mount({ onDragSizePx: live });
    live.mockClear();
    await drag.move(340);
    await drag.move(360);
    expect(live).not.toHaveBeenCalled();
    expect(drag.frames.size).toBe(1);
    await drag.flush();
    expect(drag.read().effectiveSizePx).toBe(360);
    expect(live).toHaveBeenCalledWith(360, expect.objectContaining({ attemptedSizePx: 360 }));
    await drag.move(380);
    await drag.release();
    expect(drag.commits).toHaveBeenCalledWith(380, expect.objectContaining({ attemptedSizePx: 380 }));
    expect(drag.frames.size).toBe(0);
  });

  it('requests an owner reset on double-click', async () => {
    const reset = vi.fn();
    const drag = await mount({ onResetRequest: reset });
    await act(async () => { (drag.read().webHandleProps.onDoubleClick as () => void)(); });
    expect(reset).toHaveBeenCalledOnce();
  });

  it('cancels an armed drag without collapsing or committing', async () => {
    const drag = await mount({ collapse: true });
    await drag.move(99);
    await act(async () => window.dispatchEvent(new MouseEvent('pointercancel')));
    expect(drag.collapsed).not.toHaveBeenCalled();
    expect(drag.commits).not.toHaveBeenCalled();
    expect(drag.frames.size).toBe(0);
  });
});
