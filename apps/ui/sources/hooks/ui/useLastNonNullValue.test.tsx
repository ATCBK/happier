import { describe, expect, it } from 'vitest';

import { useLastNonNullValue } from './useLastNonNullValue';
import { renderHook } from '@/dev/testkit';

type Input = Readonly<{ value: string | null; resetKey: string }>;

describe('useLastNonNullValue', () => {
    it('keeps the last non-null value when the input becomes null', async () => {
        const initialProps: Input = { value: 'a', resetKey: 'k1' };
        const hook = await renderHook((props: Input) => useLastNonNullValue(props.value, { resetKey: props.resetKey }), {
            initialProps,
        });
        expect(hook.getCurrent()).toBe('a');
        await hook.rerender({ value: null, resetKey: 'k1' });
        expect(hook.getCurrent()).toBe('a');
    });

    it('resets the stored value when resetKey changes', async () => {
        const initialProps: Input = { value: 'a', resetKey: 'k1' };
        const hook = await renderHook((props: Input) => useLastNonNullValue(props.value, { resetKey: props.resetKey }), {
            initialProps,
        });
        expect(hook.getCurrent()).toBe('a');
        await hook.rerender({ value: null, resetKey: 'k2' });
        expect(hook.getCurrent()).toBe(null);
    });
});
