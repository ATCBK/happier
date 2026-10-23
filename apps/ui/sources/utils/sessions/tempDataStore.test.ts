import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('temporary session navigation data lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        const { clearTempData } = await import('./tempDataStore');
        clearTempData();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('does no periodic work before data is stored or after its last consumer takes it', async () => {
        const { storeTempData, getTempData, peekTempData } = await import('./tempDataStore');
        expect(vi.getTimerCount()).toBe(0);

        const draft = { prompt: 'Continue this Session' };
        const key = storeTempData(draft);
        expect(peekTempData(key)).toBe(draft);
        expect(vi.getTimerCount()).toBe(1);
        expect(getTempData(key)).toBe(draft);
        expect(getTempData(key)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);

        const next = storeTempData({ prompt: 'Another draft' });
        expect(vi.getTimerCount()).toBe(1);
        expect(getTempData(next)).toEqual({ prompt: 'Another draft' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains cleanup while another entry is pending and parks after abandoned entries expire', async () => {
        const { storeTempData, getTempData, peekTempData } = await import('./tempDataStore');
        const consumed = storeTempData({ prompt: 'Consumed' });
        const abandoned = storeTempData({ prompt: 'Abandoned' });
        getTempData(consumed);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(peekTempData(abandoned)).toEqual({ prompt: 'Abandoned' });
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(peekTempData(abandoned)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases cleanup when navigation data is explicitly cleared', async () => {
        const { storeTempData, clearTempData, peekTempData } = await import('./tempDataStore');
        const key = storeTempData({ prompt: 'Cancelled' });
        clearTempData();
        expect(peekTempData(key)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
