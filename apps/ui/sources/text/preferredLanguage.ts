import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from './_all';
import { getDeviceLocales } from './deviceLocales';

let preferredLanguageOverride: SupportedLanguage | null = null;
let cachedDeviceLanguage: SupportedLanguage | null = null;
const preferredLanguageListeners = new Set<() => void>();

/** Observe committed UI language changes; loading an alternate locale does not activate it. */
export function subscribePreferredLanguage(listener: () => void): () => void {
    preferredLanguageListeners.add(listener);
    return () => { preferredLanguageListeners.delete(listener); };
}

/** Translation readiness owns when a requested language becomes the active UI language. */
export function commitPreferredLanguage(override: SupportedLanguage | null): void {
    const previous = getPreferredLanguage();
    preferredLanguageOverride = override;
    // The document names the language whose copy is ready for assistive technology and hyphenation.
    if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = getPreferredLanguage();
    if (getPreferredLanguage() !== previous) {
        for (const listener of preferredLanguageListeners) listener();
    }
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
    return (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(value);
}

function normalizeDeviceLanguageCode(languageCode: string | null | undefined, languageScriptCode: string | null | undefined): SupportedLanguage | null {
    if (typeof languageCode !== 'string') return null;

    const normalizedLanguageCode = languageCode.trim().toLowerCase();
    if (!normalizedLanguageCode) return null;

    if (normalizedLanguageCode === 'zh') {
        const normalizedScript = typeof languageScriptCode === 'string' ? languageScriptCode.trim().toLowerCase() : '';
        if (normalizedScript === 'hant') return 'zh-Hant';
        if (normalizedScript === 'hans') return 'zh-Hans';
        return 'zh-Hans';
    }

    return isSupportedLanguage(normalizedLanguageCode) ? normalizedLanguageCode : null;
}

/** Resolve an explicit language tag; unlike device selection, an unknown language has no fallback. */
export function resolveSupportedLanguageFromTag(languageTag: string): SupportedLanguage | null {
    let canonical: string | undefined;
    try {
        // Hermes exposes this API, but not Intl.Locale/maximize.
        canonical = Intl.getCanonicalLocales(languageTag.trim())[0];
    } catch {
        return null;
    }
    if (!canonical) return null;
    const [languageCode, ...subtags] = canonical.split('-');
    if (languageCode !== 'zh') return normalizeDeviceLanguageCode(languageCode, null);
    const script = /^[A-Z][a-z]{3}$/u.test(subtags[0] ?? '') ? subtags[0] : undefined;
    if (script && script !== 'Hans' && script !== 'Hant') return null;
    const chineseScript = script ?? (subtags.some((subtag) => ['TW', 'HK', 'MO'].includes(subtag)) ? 'Hant' : 'Hans');
    return normalizeDeviceLanguageCode(languageCode, chineseScript);
}

export function resolveLanguageFromDeviceLocales(): SupportedLanguage {
    if (cachedDeviceLanguage) return cachedDeviceLanguage;
    for (const locale of getDeviceLocales()) {
        const resolved = normalizeDeviceLanguageCode(locale.languageCode ?? null, locale.languageScriptCode ?? null);
        if (resolved) {
            cachedDeviceLanguage = resolved;
            return resolved;
        }
    }
    cachedDeviceLanguage = DEFAULT_LANGUAGE;
    return DEFAULT_LANGUAGE;
}

export function getPreferredLanguage(): SupportedLanguage {
    return preferredLanguageOverride ?? resolveLanguageFromDeviceLocales();
}

export function normalizePreferredLanguage(value: unknown): SupportedLanguage | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed && isSupportedLanguage(trimmed)) {
            return trimmed;
        }
    }
    return null;
}
