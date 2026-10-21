import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { MANAGED_OPTIONS_EDIT_PAUSE_MS, useSettledSelectors } from './useSettledSelectors';

describe('useSettledSelectors', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('reads the first value at once and a typed edit only after the pause, once', async () => {
        vi.useFakeTimers();
        const draft = (value: unknown) => ({ value: value as { n: number } | null, key: JSON.stringify(value) });
        const hook = await renderHook((props: ReturnType<typeof draft>) => useSettledSelectors(props.value, props.key), { initialProps: draft({ n: 1 }) });
        expect(hook.getCurrent()).toEqual({ n: 1 });
        for (const n of [2, 3, 4]) {
            await hook.rerender(draft({ n }));
            await act(async () => { await vi.advanceTimersByTimeAsync(MANAGED_OPTIONS_EDIT_PAUSE_MS - 1); });
            expect(hook.getCurrent()).toEqual({ n: 1 });
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(hook.getCurrent()).toEqual({ n: 4 });
    });
    it('does not wait to read when nothing was settled before', async () => {
        vi.useFakeTimers();
        const draft = (value: unknown) => ({ value: value as { n: number } | null, key: JSON.stringify(value) });
        const hook = await renderHook((props: ReturnType<typeof draft>) => useSettledSelectors(props.value, props.key), { initialProps: draft(null) });
        await hook.rerender(draft({ n: 1 }));
        expect(hook.getCurrent()).toEqual({ n: 1 });
    });
});
