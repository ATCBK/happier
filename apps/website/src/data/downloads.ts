/**
 * Single source of truth for every download URL and install command on the site.
 *
 * This file exists because three separate surfaces were each hand-typing URLs
 * and three of them were dead on 2026-08-08:
 *
 *   - DownloadBadges linked Google Play at `id=dev.happier`. That listing has
 *     never existed (HTTP 404). The real package id is `dev.happier.app`,
 *     which spent months as a closed testing track reachable only through the
 *     opt-in URL below, and is now the public listing in ANDROID_PLAY_URL.
 *   - DownloadBadges once pinned desktop URLs to v0.2.0. Rolling releases now
 *     publish stable aliases specifically so public links never need a version bump.
 *
 * Anything that points off this site belongs here, and `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs every one of them before a deploy.
 */

const DESKTOP_ASSET_BASE =
    'https://github.com/happier-dev/happier/releases/download/ui-desktop-stable';

export const DESKTOP_RELEASES_PAGE =
    'https://github.com/happier-dev/happier/releases/tag/ui-desktop-stable';

export const LINUX_APPIMAGE_REQUIREMENTS_URL =
    'https://docs.happier.dev/getting-started/get-the-apps#linux-appimage-prerequisites';

export type DesktopPlatformId = 'mac-arm64' | 'mac-x86_64' | 'win-x86_64' | 'linux-x86_64' | 'linux-x86_64-deb' | 'linux-x86_64-rpm';

export type DesktopPlatform = {
    id: DesktopPlatformId;
    label: string;
    sublabel: string;
    href: string;
};

function desktopAsset(file: string): string {
    return `${DESKTOP_ASSET_BASE}/${file}`;
}

export const DESKTOP_PLATFORMS: ReadonlyArray<DesktopPlatform> = [
    {
        id: 'mac-arm64',
        label: 'macOS',
        sublabel: 'Apple Silicon',
        href: desktopAsset('happier-ui-desktop-darwin-aarch64.dmg'),
    },
    {
        id: 'mac-x86_64',
        label: 'macOS',
        sublabel: 'Intel',
        href: desktopAsset('happier-ui-desktop-darwin-x86_64.dmg'),
    },
    {
        id: 'win-x86_64',
        label: 'Windows',
        sublabel: 'x64 · .exe installer',
        href: desktopAsset('happier-ui-desktop-windows-x86_64.exe'),
    },
    {
        id: 'linux-x86_64',
        label: 'Linux',
        sublabel: 'x64 · AppImage',
        href: desktopAsset('happier-ui-desktop-linux-x86_64.AppImage'),
    },
    {
        id: 'linux-x86_64-deb',
        label: 'Linux',
        sublabel: 'x64 · DEB',
        href: desktopAsset('happier-ui-desktop-linux-x86_64.deb'),
    },
    {
        id: 'linux-x86_64-rpm',
        label: 'Linux',
        sublabel: 'x64 · RPM',
        href: desktopAsset('happier-ui-desktop-linux-x86_64.rpm'),
    },
];

export const APP_STORE_URL =
    'https://apps.apple.com/app/happier-claude-codex-opencode/id6758554297';

/**
 * The direct APK, kept first-class beside the Play listing.
 *
 * It is not a legacy path: thousands of people chose the file over the store
 * while the Play track was still closed, and some keep choosing it — no Google
 * account, no store, reproducible from the release page. It follows the stable
 * rolling tag; preview and dev APKs remain available from their explicitly
 * named channel releases.
 */
export const ANDROID_APK_URL =
    'https://github.com/happier-dev/happier/releases/download/ui-mobile-stable/happier-android.apk';

/**
 * The closed-track opt-in URL from before the listing went public. Still a
 * working entry point for accounts already on the tester list, and still
 * referenced by older docs, so it stays — as a footnote, not a badge.
 */
export const ANDROID_PLAY_TESTING_OPT_IN_URL =
    'https://play.google.com/apps/testing/dev.happier.app';

/**
 * The public Play listing.
 *
 * For a long time this docblock was a warning: the track was closed, the URL
 * 404ed for everyone but opted-in testers, and the Play-first badge was only
 * allowed to ship the day the listing went public. That day has come — the
 * listing is live, DownloadBadges leads with Play, and the APK stays one click
 * behind the chevron for the people who want the file.
 *
 * The safety net outlives the warning: `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs this URL with every other outbound
 * link before a deploy, so a pulled listing or a re-closed track fails the
 * check instead of shipping as a dead badge.
 */
export const ANDROID_PLAY_URL = 'https://play.google.com/store/apps/details?id=dev.happier.app';

export const WEB_APP_URL = 'https://cloud.happier.dev/';
export const DOCS_URL = 'https://docs.happier.dev/';
export const GUIDES_URL = 'https://guides.happier.dev/';
export const GITHUB_REPO_URL = 'https://github.com/happier-dev/happier';

/** The repo spells it LICENCE. `…/blob/main/LICENSE` is a 404. */
export const LICENSE_URL = 'https://github.com/happier-dev/happier/blob/main/LICENCE';

/** `docs.happier.dev/changelog` is a 404; the route is /releases. */
export const CHANGELOG_URL = 'https://docs.happier.dev/releases';

export const INSTALL_SCRIPT_URL = 'https://happier.dev/install.sh';
export const INSTALL_SCRIPT_PS1_URL = 'https://happier.dev/install.ps1';
export const RELEASE_PUBKEY_URL = 'https://happier.dev/happier-release.pub';

/**
 * The minisign public key the installer verifies every release against.
 *
 * Printed on the page so a reader can compare it against the copy compiled into
 * install.sh (line 25-29) and the copy served at /happier-release.pub without
 * running anything.
 */
export const RELEASE_PUBKEY_ID = '91AE28177BF6E43C';
export const RELEASE_PUBKEY =
    'RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t';

export const INSTALL_COMMAND_UNIX = 'curl -fsSL https://happier.dev/install | bash';
export const INSTALL_COMMAND_WINDOWS = 'iwr https://happier.dev/install.ps1 -useb | iex';

/** The two-step, nothing-piped-to-a-shell version, for readers who want it. */
export const INSTALL_COMMAND_UNIX_INSPECTABLE = [
    'curl -fsSL https://happier.dev/install.sh -o happier-install.sh',
    'less happier-install.sh   # read it first',
    'bash happier-install.sh',
].join('\n');
