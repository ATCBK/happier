import { describe, expect, it } from 'vitest';

describe('LocalDateTimeEditor module initialization', () => {
    it('imports the editor before any presentation host or picker has been loaded', async () => {
        const { LocalDateTimeEditor } = await import('./LocalDateTimeEditor');
        expect(LocalDateTimeEditor).toBeTypeOf('function');
    });
});
