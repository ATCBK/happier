import type { SupportedLanguage } from './_all';
import type { LocaleBundle } from './localeBundlesSync';

// Metro requires literal module paths. Keep each require inside its locale's lookup:
// native activation stays synchronous without evaluating the other locale payloads.
// The assertions type Metro's otherwise untyped CommonJS module boundary.
const load = {
    en: () => ({
        host: (require('./translations/en') as typeof import('./translations/en')).en,
        plugins: (require('./bundledPluginTranslations/en.generated') as typeof import('./bundledPluginTranslations/en.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    ca: () => ({
        host: (require('./translations/ca') as typeof import('./translations/ca')).ca,
        plugins: (require('./bundledPluginTranslations/ca.generated') as typeof import('./bundledPluginTranslations/ca.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    de: () => ({
        host: (require('./translations/de') as typeof import('./translations/de')).de,
        plugins: (require('./bundledPluginTranslations/de.generated') as typeof import('./bundledPluginTranslations/de.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    es: () => ({
        host: (require('./translations/es') as typeof import('./translations/es')).es,
        plugins: (require('./bundledPluginTranslations/es.generated') as typeof import('./bundledPluginTranslations/es.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    fr: () => ({
        host: (require('./translations/fr') as typeof import('./translations/fr')).fr,
        plugins: (require('./bundledPluginTranslations/fr.generated') as typeof import('./bundledPluginTranslations/fr.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    it: () => ({
        host: (require('./translations/it') as typeof import('./translations/it')).it,
        plugins: (require('./bundledPluginTranslations/it.generated') as typeof import('./bundledPluginTranslations/it.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    ja: () => ({
        host: (require('./translations/ja') as typeof import('./translations/ja')).ja,
        plugins: (require('./bundledPluginTranslations/ja.generated') as typeof import('./bundledPluginTranslations/ja.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    pl: () => ({
        host: (require('./translations/pl') as typeof import('./translations/pl')).pl,
        plugins: (require('./bundledPluginTranslations/pl.generated') as typeof import('./bundledPluginTranslations/pl.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    pt: () => ({
        host: (require('./translations/pt') as typeof import('./translations/pt')).pt,
        plugins: (require('./bundledPluginTranslations/pt.generated') as typeof import('./bundledPluginTranslations/pt.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    ru: () => ({
        host: (require('./translations/ru') as typeof import('./translations/ru')).ru,
        plugins: (require('./bundledPluginTranslations/ru.generated') as typeof import('./bundledPluginTranslations/ru.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    'zh-Hans': () => ({
        host: (require('./translations/zh-Hans') as typeof import('./translations/zh-Hans')).zhHans,
        plugins: (require('./bundledPluginTranslations/zh-Hans.generated') as typeof import('./bundledPluginTranslations/zh-Hans.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
    'zh-Hant': () => ({
        host: (require('./translations/zh-Hant') as typeof import('./translations/zh-Hant')).zhHant,
        plugins: (require('./bundledPluginTranslations/zh-Hant.generated') as typeof import('./bundledPluginTranslations/zh-Hant.generated')).BUNDLED_PLUGIN_TRANSLATIONS,
    }),
} satisfies Record<SupportedLanguage, () => LocaleBundle>;

export function readLocaleBundle(language: SupportedLanguage): LocaleBundle | undefined {
    return load[language]();
}

export async function preloadLocaleBundle(language: SupportedLanguage): Promise<void> {
    readLocaleBundle(language);
}
