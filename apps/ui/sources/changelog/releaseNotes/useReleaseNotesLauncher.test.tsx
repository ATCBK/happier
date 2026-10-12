import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { SettingsAboutSection } from '@/components/settings/SettingsAboutSection';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { OVERVIEW_SETTINGS } from '@/components/settings/overview/overviewSettings';
import { useRouter as useDestinationRouter } from '@/components/appShell/workspace/destinationRoute';

import { setLastSeenReleaseId } from './storage';

type ReleaseNotesModalProps = Readonly<{
    onComplete?: () => void;
    onDismiss?: () => void;
    onViewFullChangelog?: () => void;
}>;

type ReleaseNotesModalConfig = Readonly<{
    onRequestClose?: () => void;
    props?: ReleaseNotesModalProps;
}>;

const release = {
    releaseId: 'v1.0.0',
    versionLabel: 'v1.0.0',
    publishedAt: '2026-01-01T00:00:00.000Z',
    titleKey: 'releaseNotes.title',
    cards: [
        {
            kind: 'list' as const,
            titleKey: 'releaseNotes.card.title',
            rows: [{ iconId: 'sparkles', titleKey: 'releaseNotes.card.rowTitle', bodyKey: 'releaseNotes.card.rowBody' }],
        },
    ],
};

const modalState = vi.hoisted(() => ({
    lastConfig: null as ReleaseNotesModalConfig | null,
    lastProps: null as ReleaseNotesModalProps | null,
    show: vi.fn((config: ReleaseNotesModalConfig) => {
        modalState.lastConfig = config;
        modalState.lastProps = config.props ?? null;
        return 'release-notes-modal';
    }),
    hide: vi.fn(),
}));

const routerMock = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
const originalEnv = { ...process.env };
const telemetry = vi.hoisted(() => ({ whatsNew: vi.fn() }));
// Analytics delivery is an external boundary; the Settings row and launcher stay real.
vi.mock('@/track', () => ({ trackWhatsNewClicked: telemetry.whatsNew, trackLogout: vi.fn() }));

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/modal', () => ({
    Modal: {
        show: modalState.show,
        hide: modalState.hide,
    },
}));

vi.mock('@/components/changelog/releaseNotes', () => ({
    ReleaseNotesStorySurface: 'ReleaseNotesStorySurface',
}));

vi.mock('./manifestRuntime', () => ({
    getCurrentReleaseEntry: () => release,
    getActiveManifest: () => ({ schemaVersion: 'v1', generatedAt: '2026-01-01T00:00:00.000Z', releases: [release] }),
    getCurrentReleaseId: () => release.releaseId,
    findReleaseForId: () => release,
}));

describe('useReleaseNotesLauncher', () => {
    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'app.ui.releaseNotes';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        setLastSeenReleaseId('v0.9.0');
        modalState.lastConfig = null;
        modalState.lastProps = null;
        modalState.show.mockClear();
        modalState.hide.mockClear();
        routerMock.spies.push.mockClear();
        telemetry.whatsNew.mockClear();
    });

    afterEach(() => {
        standardCleanup();
        process.env = { ...originalEnv };
    });

    async function renderLauncherAndUnread() {
        const { useReleaseNotesLauncher } = await import('./useReleaseNotesLauncher');
        const { useReleaseNotesUnread } = await import('./useReleaseNotesUnread');
        return renderHook(() => ({
            launcher: useReleaseNotesLauncher(),
            unread: useReleaseNotesUnread(),
        }));
    }

    it('clears unread state when the release story completes', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onComplete?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(modalState.hide).toHaveBeenCalledWith('release-notes-modal');

        await hook.unmount();
    });

    it('clears unread state when the release story is dismissed', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onDismiss?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);

        await hook.unmount();
    });

    it('clears unread state when the modal backdrop dismisses the release story', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastConfig?.onRequestClose?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(modalState.hide).toHaveBeenCalledWith('release-notes-modal');

        await hook.unmount();
    });

    it('clears unread state when opening the full changelog from the release story', async () => {
        const hook = await renderLauncherAndUnread();
        expect(hook.getCurrent().unread.hasUnread).toBe(true);

        expect(hook.getCurrent().launcher.open()).toBe(true);
        await act(async () => {
            modalState.lastProps?.onViewFullChangelog?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/changelog');

        await hook.unmount();
    });

    it('does not open the release story when the release-notes feature is denied', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.releaseNotes';
        const hook = await renderLauncherAndUnread();

        expect(hook.getCurrent().unread.hasUnread).toBe(false);
        expect(hook.getCurrent().launcher.open()).toBe(false);
        expect(modalState.show).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('does not open the release story without an explicit story allow', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = '';
        const hook = await renderLauncherAndUnread();

        expect(hook.getCurrent().unread.hasUnread).toBe(true);
        expect(hook.getCurrent().launcher.open()).toBe(false);
        expect(modalState.show).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it("opens What's new as the unread release story, else as the full release notes", async () => {
        const hook = await renderLauncherAndUnread();

        hook.getCurrent().launcher.openWhatsNew();
        expect(modalState.show).toHaveBeenCalledTimes(1);
        expect(routerMock.spies.push).not.toHaveBeenCalled();

        await act(async () => {
            modalState.lastProps?.onDismiss?.();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        hook.getCurrent().launcher.openWhatsNew();
        expect(modalState.show).toHaveBeenCalledTimes(1);
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/changelog');

        await hook.unmount();
    });

    it("opens Settings What's new through the unread-story decision and preserves click telemetry", async () => {
        function About() {
            const router = useDestinationRouter();
            return <SettingsAboutSection appVersion="1.0.0" handleGitHub={() => {}}
                handleVersionClick={() => {}} router={router} showChangelog showRateUs={false} supportUs={null} />;
        }
        const screen = await renderScreen(<About />);
        const press = () => screen.findAllByType(SettingRow).find(row => row.props.setting === OVERVIEW_SETTINGS.settings.whatsNew)!.props.onPress();
        await act(async () => { press(); });
        expect(modalState.lastConfig).not.toBeNull();
        expect(routerMock.spies.push).not.toHaveBeenCalled();
        await act(async () => { modalState.lastProps?.onDismiss?.(); });
        await act(async () => { press(); });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/changelog');
        expect(telemetry.whatsNew).toHaveBeenCalledTimes(2);
    });
});
