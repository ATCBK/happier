#!/usr/bin/env node
/**
 * HEAD every outbound URL the marketing site sends a visitor to, and fail if
 * any of them is not reachable.
 *
 * On 2026-08-08 the deployed site had six dead outbound links at once — all
 * four desktop downloads, the Google Play badge, the LICENSE link, and the
 * changelog link — and nothing in the repo could have caught any of them,
 * because they were string literals inside JSX. This script is the missing
 * check. Run it before every deploy:
 *
 *     node --experimental-strip-types scripts/check-download-links.mjs
 *
 * It is deliberately NOT a vitest: it needs the network, and a unit suite that
 * fails when GitHub has a bad minute is a suite people learn to ignore.
 */

import * as downloads from '../src/data/downloads.ts';

const TARGETS = [
    ...downloads.DESKTOP_PLATFORMS.map(({ href }) => href),
    downloads.DESKTOP_RELEASES_PAGE,
    downloads.LINUX_APPIMAGE_REQUIREMENTS_URL,

    // Mobile. The Play listing is also the target of the /playstore short link
    // (public/_redirects, printed as a QR code on marketing assets), the App
    // Store URL is /appstore's, and the stable APK is /apk's — a pulled listing
    // or asset must fail this check.
    downloads.APP_STORE_URL,
    downloads.ANDROID_APK_URL,
    downloads.ANDROID_PLAY_URL,

    // Installer + trust surface
    'https://happier.dev/install',
    downloads.INSTALL_SCRIPT_URL,
    downloads.INSTALL_SCRIPT_PS1_URL,
    downloads.RELEASE_PUBKEY_URL,

    // Product surfaces
    downloads.WEB_APP_URL,
    downloads.DOCS_URL,
    'https://docs.happier.dev/security',
    'https://docs.happier.dev/providers',
    downloads.CHANGELOG_URL,
    'https://docs.happier.dev/getting-started/onboarding',
    'https://docs.happier.dev/deployment/self-host-runtime',
    downloads.GUIDES_URL,

    // Repo — note the British spelling; /LICENSE is a 404.
    downloads.GITHUB_REPO_URL,
    downloads.LICENSE_URL,
    'https://github.com/happier-dev/happier/graphs/contributors',

    // Published stats the counters read.
    'https://stats.happier.dev/downloads.json',
    'https://stats.happier.dev/discord.json',

    // Community
    'https://discord.gg/W6Pb8KuHfg',
];

const results = await Promise.all(
    TARGETS.map(async (url) => {
        try {
            let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            // Some CDNs reject HEAD outright; retry as a ranged GET before failing.
            if (res.status === 405 || res.status === 403) {
                res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
            }
            return { url, status: res.status, ok: res.status < 400 };
        } catch (error) {
            return { url, status: String(error?.message ?? error), ok: false };
        }
    }),
);

let failed = 0;
for (const { url, status, ok } of results) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(6)} ${url}`);
}

if (failed > 0) {
    console.error(`\n${failed} of ${results.length} links are dead. Do not deploy.`);
    process.exit(1);
}
console.log(`\nAll ${results.length} links reachable.`);
