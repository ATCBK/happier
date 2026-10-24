import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDeviceLocales: vi.fn(() => [{ languageCode: 'en', languageScriptCode: null }]),
}));

vi.mock('./deviceLocales', () => ({
    getDeviceLocales: mocks.getDeviceLocales,
}));

describe('text/i18n device locale resolution', () => {
    it('caches the resolved device language instead of reading device locales for every translation', async () => {
        const { t, tLoose } = await import('./i18n');

        expect(t('tabs.inbox')).toBe('Inbox');
        expect(tLoose('tabs.settings')).toBe('Settings');
        expect(t('common.error')).toBe('Error');

        expect(mocks.getDeviceLocales).toHaveBeenCalledTimes(1);
    });

    it('paints a cold non-default device locale only after the existing boot readiness owner', async () => {
        vi.resetModules();
        mocks.getDeviceLocales.mockReturnValue([{ languageCode: 'es', languageScriptCode: null }]);
        try {
            const text = await import('./i18n');
            const { runAppBootSequence } = await import('@/boot/runAppBootSequence');
            let firstPaint: { language: string; copy: string } | undefined;
            await runAppBootSequence({
                loadFonts: async () => {},
                sodiumReady: Promise.resolve(),
                resolveCredentials: async () => null,
                prepareWarmCache: async () => {},
                prepareSessionDrafts: async () => {},
                prepareTranslations: () => text.preloadTranslations(),
                restoreSync: null,
                onReady: () => { firstPaint = { language: text.getPreferredLanguage(), copy: text.t('tabs.inbox') }; },
            });
            expect(firstPaint).toEqual({ language: 'es', copy: text.getTranslationValue('tabs.inbox', 'es') });
            expect(firstPaint?.copy).not.toBe('Inbox');
            expect(text.t('agentInput.connectedServiceLabel.gemini')).toBe('Google Gemini');
        } finally {
            mocks.getDeviceLocales.mockReturnValue([{ languageCode: 'en', languageScriptCode: null }]);
        }
    });
});
