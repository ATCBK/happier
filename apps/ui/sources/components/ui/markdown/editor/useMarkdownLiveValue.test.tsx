import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { useMarkdownLiveValue } from './useMarkdownLiveValue';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('follows publication, pauses while inactive, and resumes current text without frame polling', async () => {
    let value = '# Initial';
    let observed = '';
    const listeners = new Set<() => void>();
    const liveValue = { get: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const frame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frame);
    function Probe({ active }: { active: boolean }) {
        observed = useMarkdownLiveValue('# Seed', liveValue, active);
        return null;
    }
    let tree: ReturnType<typeof create> | undefined;
    try {
        await act(async () => { tree = create(<Probe active />); });
        expect(observed).toBe('# Initial');
        value = '# Published';
        expect(observed).toBe('# Initial');
        await act(async () => { listeners.forEach((listener) => listener()); });
        expect(observed).toBe('# Published');
        await act(async () => { tree!.update(<Probe active={false} />); });
        expect(listeners.size).toBe(0);
        value = '# Hidden edit';
        await act(async () => { tree!.update(<Probe active />); });
        expect(observed).toBe('# Hidden edit');
        expect(frame).not.toHaveBeenCalled();
    } finally {
        await act(async () => { tree?.unmount(); });
        vi.unstubAllGlobals();
    }
    expect(listeners.size).toBe(0);
});
