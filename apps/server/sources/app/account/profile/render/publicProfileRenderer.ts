import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StyleSheet } from 'react-native-web';
import { HappierUiEnvironmentProvider, HappierUiTypographyProvider } from '@happier-dev/plugin-ui/environment';
import { HappierPublicProfile } from '@happier-dev/plugin-ui/components';
import { usagePlanetMeridianWeight } from '@happier-dev/plugin-ui/presentation';
import type { HappierPublicProfileHeroGeometry, UsagePlanetSpec } from '@happier-dev/plugin-ui/presentation';
import { createPlanetDots, createPlanetScene, planetLightForProgress } from '@happier-dev/brand/planet';
import { readBundledAgentPresentation, getNeutralAgentIdentityColor } from '@happier-dev/agents/presentation';
import type { PublicProfileReadResultV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { createPublicProfileTheme, PUBLIC_PROFILE_TYPOGRAPHY, PUBLIC_PROFILE_PALETTES } from './publicProfileEnvironment';
import { publicProfilePageLabels, PUBLIC_PROFILE_LOCALE, PUBLIC_PROFILE_STATE_LABELS } from './publicProfileLabels';
import { publicProfileUsageLabels } from './publicProfileUsageLabels';
import type { PublicProfileHeroData } from './publicProfileHero';

export type PublicProfileBodyInput = Readonly<{
    result: PublicProfileReadResultV1;
    scheme: 'light' | 'dark';
    hero?: PublicProfileHeroData;
    singleColumn?: boolean;
}>;

/** The same portable page as owner preview, rendered before any client effects or measurement. */
export function renderPublicProfileBody(input: PublicProfileBodyInput): { markup: string; css: string } {
    const hero = input.hero;
    const palette = PUBLIC_PROFILE_PALETTES[input.scheme];
    const view = input.result.kind === 'published' ? createElement(HappierPublicProfile, { view: input.result.view,
        labels: { ...publicProfilePageLabels(input.result.view), ...(hero?.credit ? { heroCredit: hero.credit } : {}) },
        singleColumn: input.singleColumn ?? false,
        usage: {
            cold: true,
            paint: { accent: createPublicProfileTheme(input.scheme).colors.accent, paper: palette.background, dark: input.scheme === 'dark' },
            agent: (id: string) => {
                const metadata = readBundledAgentPresentation(id);
                return { id, name: metadata?.name ?? id,
                    color: metadata?.identityColor?.[input.scheme] ?? getNeutralAgentIdentityColor({ dark: input.scheme === 'dark' }) };
            },
            labels: publicProfileUsageLabels(input.result.view),
            renderPlanet: (spec: UsagePlanetSpec) => renderUsagePlanet(spec, input.scheme),
        },
        ...(hero ? { renderHero: (geometry: HappierPublicProfileHeroGeometry) => {
            const images = hero.editions[input.scheme][geometry.singleColumn ? 'phone' : 'wide'];
            return createElement('img', { src: images.one.src, srcSet: `${images.one.src} 1x, ${images.two.src} 2x`,
                alt: '', width: images.one.width, height: images.one.height,
                style: { display: 'block', width: '100%', height: geometry.bandHeightPx, objectFit: 'cover' } });
        } } : {}),
    }) : createElement(HappierPublicProfile, { result: input.result,
        labels: PUBLIC_PROFILE_STATE_LABELS });
    const markup = renderToStaticMarkup(createElement(HappierUiEnvironmentProvider, {
        environment: { theme: createPublicProfileTheme(input.scheme),
            localization: { locale: PUBLIC_PROFILE_LOCALE, direction: 'ltr', translate: (_key, fallback) => fallback ?? '' },
            accessibility: { textScale: 1, reducedMotion: true, screenReaderEnabled: false, contrast: 'normal' },
            platform: { platform: 'web', colorScheme: input.scheme },
            insets: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 } } },
        children: createElement(HappierUiTypographyProvider, { typography: PUBLIC_PROFILE_TYPOGRAPHY, children: view }),
    }), { identifierPrefix: `public-profile-${input.scheme}-${input.singleColumn ? 'phone' : 'wide'}-` });
    return { markup, css: StyleSheet.getSheet().textContent };
}

/** Physical SVG binding of the same Brand scene and body-derived inputs as the app's canvas slot. */
function renderUsagePlanet(spec: UsagePlanetSpec, scheme: 'light' | 'dark') {
    const light = spec.light === undefined ? undefined : planetLightForProgress(spec.light);
    // A small phase mark uses the Brand mark lattice; a painted planet weights its own dots by the shared meridian rule.
    const dots = spec.mark
        ? createPlanetDots({ size: spec.size, theme: scheme, halo: spec.halo, ...(light ? { light } : {}) })
            .map(dot => ({ x: dot.x, y: dot.y, r: dot.radius, rgb: dot.rgb, opacity: dot.opacity }))
        : (() => {
            const scene = createPlanetScene({ theme: scheme, R: spec.radius, cx: spec.size / 2, cy: spec.size / 2,
                view: { w: spec.size, h: spec.size }, rotate: spec.rotate, mirror: false, fullness: spec.meridians ? 1 : spec.night ?? 0,
                halo: spec.meridians ? 0 : spec.halo, tail: spec.meridians ? 0 : spec.tail, rise: spec.rise, style: spec.style,
                field: { around: 0, over: 0 }, ...(light ? { light } : {}) });
            return spec.meridians ? scene.body.map(dot => ({ ...dot, opacity: dot.opacity * usagePlanetMeridianWeight(spec, dot.x) }))
                : [...scene.body, ...scene.haze];
        })();
    return createElement('svg', { width: spec.size, height: spec.size, viewBox: `0 0 ${spec.size} ${spec.size}`, 'aria-hidden': true },
        dots.map((dot, index) => createElement('circle', { key: index,
            cx: dot.x, cy: dot.y, r: dot.r, fill: spec.ink ?? `rgb(${dot.rgb.map(value => value | 0).join(',')})`, opacity: dot.opacity })));
}
