import { expect, it, vi } from 'vitest';

it('configures the hosted guest Mini core with English errors', async () => {
    vi.resetModules();
    const mini = await import('zod/mini');
    const previous = { ...mini.config() };
    mini.config({ customError: undefined, localeError: () => 'Mini locale missing' });
    try {
        await import('./configureZodLocale.js');
        const actual = mini.string().check(mini.minLength(3)).safeParse('ab');
        if (actual.success) throw new Error('The comparison input must be invalid');
        expect(actual.error.issues[0]?.message).toBe('Too small: expected string to have >=3 characters');
        expect(actual.error.issues[0]?.message).not.toBe('Mini locale missing');
    } finally {
        mini.config(previous);
    }
});
