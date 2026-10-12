// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'preact/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ReactDOMClient from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { mount } from '../entries/_mount';

import { LOCALES, LOCALE_META, SITE_ORIGIN, localePath, localeUrl, pathForLocale } from './index';
import { ROUTES, localesFor, fileForRoute, findRoute, headTagsFor } from '../routes';

// Renderer boundary capture keeps the actual framework implementation and permits root cleanup.
vi.mock('react-dom/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom/client')>();
    return {
        ...actual,
        createRoot: vi.fn(actual.createRoot),
        hydrateRoot: vi.fn(actual.hydrateRoot),
    };
});

/** The SSR footer and browser suggestion must consume the route's published alternatives. */
describe('the footer locale switcher only ever links to pages that exist', () => {
    it.each(['/download', '/ja/security'])('renders only published footer alternatives on %s', (path) => {
        const route = findRoute(path)!;
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(createElement(App, { path }));
        const switcher = container.querySelector('[data-section="locale-switcher"]');
        expect(switcher?.tagName).toBe('DETAILS');
        expect([...switcher!.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(
            localesFor(route).map((locale) => pathForLocale(locale, path)),
        );
    });

    it.each(['/download', '/security'])('offers only a published browser-language alternative on %s', async (path) => {
        const route = findRoute(path)!;
        const savedHead = document.head.innerHTML;
        const savedLanguages = Object.getOwnPropertyDescriptor(navigator, 'languages');
        const savedActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
        // Capture real renderer roots only to dispose their effects after the page-entry test.
        const rootSpy = vi.mocked(ReactDOMClient.createRoot);
        const hydrationSpy = vi.mocked(ReactDOMClient.hydrateRoot);
        try {
            // Browser environment boundaries: served canonical head, preferred language and pathname.
            document.head.innerHTML = headTagsFor(route, 'en');
            document.body.innerHTML = `<div id="root">${renderToStaticMarkup(createElement(App, { path }))}</div>`;
            history.replaceState(null, '', path);
            localStorage.clear();
            Object.defineProperty(navigator, 'languages', { configurable: true, value: ['ja-JP'] });
            Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
            await act(async () => {
                mount('en');
                await vi.dynamicImportSettled();
            });
            const link = document.querySelector('[data-section="locale-suggestion"] a');
            expect(link?.getAttribute('href') ?? null).toBe(
                localesFor(route).includes('ja') ? pathForLocale('ja', path) : null,
            );
            expect([...document.querySelectorAll('[data-section="locale-switcher"] a')].map((a) => a.getAttribute('href'))).toEqual(
                localesFor(route).map((locale) => pathForLocale(locale, path)),
            );
        } finally {
            await act(async () => {
                for (const result of [...rootSpy.mock.results, ...hydrationSpy.mock.results]) {
                    if (result.type === 'return') result.value.unmount();
                }
            });
            rootSpy.mockClear();
            hydrationSpy.mockClear();
            document.head.innerHTML = savedHead;
            document.body.replaceChildren();
            history.replaceState(null, '', '/');
            localStorage.clear();
            if (savedLanguages) Object.defineProperty(navigator, 'languages', savedLanguages);
            else Reflect.deleteProperty(navigator, 'languages');
            if (savedActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', savedActEnvironment);
            else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
        }
    });

    it('builds a URL the prerenderer actually writes, for every route and locale', () => {
        // The switcher's href and the file on disk are produced by two different
        // functions — pathForLocale here, localeUrl in the route manifest — and
        // a trailing-slash or prefix disagreement between them is a 404 that no
        // type checks and no page shows until someone clicks.
        const built = new Set(
            ROUTES.flatMap((route) =>
                localesFor(route).map((locale) => {
                    const prefix = LOCALE_META[locale].pathPrefix;
                    const path = route.path === '/' ? prefix || '/' : `${prefix}${route.path}`;
                    return fileForRoute(path);
                }),
            ),
        );

        for (const route of ROUTES) {
            for (const from of localesFor(route)) {
                const fromPrefix = LOCALE_META[from].pathPrefix;
                const currentPath = route.path === '/' ? fromPrefix || '/' : `${fromPrefix}${route.path}`;

                for (const to of localesFor(route)) {
                    const href = pathForLocale(to, currentPath);
                    expect(
                        built.has(fileForRoute(href)),
                        `switcher on ${currentPath} links to ${href}, which the build does not write`,
                    ).toBe(true);
                }
            }
        }
    });

    /**
     * The href must be the target page's CANONICAL url, not merely a url that
     * resolves to it. `/zh/` and `/zh` are the same file on Cloudflare Pages, so
     * a switcher that linked to the first would work perfectly and still point
     * every internal link on the site at a non-canonical address — invisible
     * until something counts them.
     */
    it('links to each page at exactly the URL it declares as canonical', () => {
        for (const route of ROUTES) {
            for (const to of localesFor(route)) {
                const canonical = localeUrl(to, route.path).slice(SITE_ORIGIN.length);
                for (const from of localesFor(route)) {
                    const fromPrefix = LOCALE_META[from].pathPrefix;
                    const currentPath = route.path === '/' ? fromPrefix || '/' : `${fromPrefix}${route.path}`;
                    expect(
                        pathForLocale(to, currentPath),
                        `switcher on ${currentPath} links to ${to}`,
                    ).toBe(canonical);
                }
            }
        }
    });

    it('has a native name and banner copy for every locale', () => {
        for (const locale of LOCALES) {
            const meta = LOCALE_META[locale];
            expect(meta.nativeName.length, `${locale} has no nativeName`).toBeGreaterThan(0);
            // The banner speaks the language it is OFFERING, so these cannot fall
            // back to English the way a catalogue string can.
            expect(meta.suggestion.offer.length, `${locale} suggestion.offer`).toBeGreaterThan(0);
            expect(meta.suggestion.action.length, `${locale} suggestion.action`).toBeGreaterThan(0);
            expect(meta.suggestion.dismiss.length, `${locale} suggestion.dismiss`).toBeGreaterThan(0);
        }
    });
});

/**
 * localePath is what every internal link on the site goes through, and the
 * cases below are the ones that were actually wrong or would have been.
 *
 * scripts/assert-locale-links.mjs is the real guarantee — it reads the built
 * HTML and cannot be fooled by a link site nobody remembered. This is here for
 * the edge cases that are cheaper to state than to infer from 6,000 hrefs.
 */
describe('localePath', () => {
    it('is the identity for the default locale, which keeps the English build unchanged', () => {
        for (const href of ['/', '/agents', '/#faq', 'https://github.com/x']) {
            expect(localePath('en', href)).toBe(href);
        }
    });

    it('sends the home link to /zh, never /zh/ — the URL that page calls canonical', () => {
        expect(localePath('zh-Hant', '/')).toBe('/zh-Hant');
        expect(localePath('zh-Hant', '/')).toBe(localeUrl('zh-Hant', '/').slice(SITE_ORIGIN.length));
    });

    it('hangs an off-home anchor off the locale root, not off a trailing slash', () => {
        expect(localePath('ja', '/#faq')).toBe('/ja#faq');
        expect(localePath('ja', '#faq')).toBe('#faq');
    });

    it('leaves anything that is not our own route alone', () => {
        for (const href of ['https://docs.happier.dev', 'mailto:a@b.c', '//cdn.example/x']) {
            expect(localePath('ru', href)).toBe(href);
        }
    });

    it('never prefixes twice, and never prefixes another locale’s path', () => {
        expect(localePath('ru', '/ru/agents')).toBe('/ru/agents');
        expect(localePath('ru', localePath('ru', '/agents'))).toBe('/ru/agents');
        // The switcher builds these; re-prefixing would give /ru/fr/agents.
        expect(localePath('ru', '/fr/agents')).toBe('/fr/agents');
    });

    it('prefixes for every locale the site ships', () => {
        for (const locale of LOCALES) {
            const prefix = LOCALE_META[locale].pathPrefix;
            expect(localePath(locale, '/agents')).toBe(`${prefix}/agents`);
        }
    });
});
