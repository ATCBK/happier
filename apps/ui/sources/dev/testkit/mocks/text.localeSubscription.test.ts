import { expect, it, vi } from 'vitest';

import { act, renderHook } from '../hooks/renderHook';

// The translation presentation boundary may itself use the canonical text fixture.
vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('./text');
    return createTextModuleMock();
});

it('initializes a mocked translation module without losing the real committed-language subscription', async () => {
    const { createTextModuleMock } = await import('./text');
    const text = await vi.importActual<typeof import('@/text/i18n')>('@/text/i18n');
    text.setPreferredLanguageFromSettings('en');
    const fixture = createTextModuleMock();
    const hook = await renderHook(() => fixture.usePreferredLanguage());
    try {
        expect(hook.getCurrent()).toBe('en');
        await act(async () => {
            text.setPreferredLanguageFromSettings('es');
            await text.preloadTranslations();
        });
        expect(hook.getCurrent()).toBe('es');
        await act(async () => { await text.preloadTranslations('fr'); });
        expect(hook.getCurrent()).toBe('es');
        await act(async () => { text.setPreferredLanguageFromSettings('fr'); });
        expect(hook.getCurrent()).toBe('fr');
    } finally {
        await hook.unmount();
        text.setPreferredLanguageFromSettings(null);
    }
});
