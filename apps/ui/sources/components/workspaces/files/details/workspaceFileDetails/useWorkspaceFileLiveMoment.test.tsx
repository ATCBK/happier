import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { useWorkspaceFileLiveMoment } from './useWorkspaceFileLiveMoment';

const content = (text: string, hash = text) => ({ content: text, contentHash: hash, isBinary: false });
const initial = { resourceKey: 'file.txt', content: content('one\nthree\n'),
    isActive: true, isEditing: false, hasDraft: false, reducedMotion: false };

it('publishes one changed-line batch, holds equal-hash echoes, and continues the existing fade on the next batch', async () => {
    const hook = await renderHook(useWorkspaceFileLiveMoment, { initialProps: initial });
    expect(hook.getCurrent()).toBe(null);
    await hook.rerender({ ...initial, content: content('one\ntwo\nthree\n') });
    expect(hook.getCurrent()?.changedLines).toEqual([2]);
    const batch = hook.getCurrent();
    await hook.rerender({ ...initial, content: content('one\ntwo\nthree\n') });
    expect(hook.getCurrent()).toBe(batch);
    await hook.rerender({ ...initial, content: content('one\nTWO\nthree\n') });
    expect(hook.getCurrent()).not.toBe(batch);
    expect(hook.getCurrent()?.changedLines).toEqual([2]);
    await hook.unmount();
});

it.each([{ isEditing: true }, { hasDraft: true }, { isActive: false }])('does not announce a live View update for %j', async flags => {
    const hook = await renderHook(useWorkspaceFileLiveMoment, { initialProps: initial });
    await hook.rerender({ ...initial, ...flags, content: content('changed\n') });
    expect(hook.getCurrent()).toBe(null);
    await hook.unmount();
});

it('updates the meta without tint under reduced motion and suppresses own-save echoes', async () => {
    const hook = await renderHook(useWorkspaceFileLiveMoment, { initialProps: { ...initial, ownWriteHash: null as string | null } });
    await hook.rerender({ ...initial, ownWriteHash: 'save', content: content('mine\n', 'save') });
    expect(hook.getCurrent()).toBe(null);
    await hook.rerender({ ...initial, ownWriteHash: 'save', reducedMotion: true, content: content('agent\n', 'agent') });
    expect(hook.getCurrent()?.changedLines).toEqual([]);
    expect(hook.getCurrent()?.contentHash).toBe('agent');
    await hook.rerender({ ...initial, resourceKey: 'other.txt', ownWriteHash: null, content: content('other\n') });
    expect(hook.getCurrent()).toBe(null);
    await hook.unmount();
});
