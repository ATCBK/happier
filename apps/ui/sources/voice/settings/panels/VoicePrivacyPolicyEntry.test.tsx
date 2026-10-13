import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { createVoiceSettingsAccountTestHarness } from './voiceSettingsAccountTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';

/**
 * §2.8 / §7.3 — the one in-app privacy destination for Voice.
 *
 * No active Voice surface carries a provider/data-disclosure affordance any more,
 * so Voice settings is where a compliance entry point has to exist. It is
 * deliberately quiet — bottom of the screen, no interruption — but it still has
 * to be a real, reachable control that opens the public policy through the
 * canonical external-URL opener rather than a hand-rolled `Linking` call.
 */

const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => {}));

vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

// Opening the system browser is the boundary; declared rows and the URL owner stay real.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios' }, Linking: { openURL: openUrl, canOpenURL: async () => true },
  }));
const initialStorage = storage.getState();
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => { account = await createVoiceSettingsAccountTestHarness(settingsParse({})); });
afterEach(async () => { standardCleanup(); await account.dispose(); storage.setState(initialStorage, true); });

// Install Account transport before importing the real screen and About consumer graphs.
const { VoicePrivacyPolicyEntry } = await import('./VoicePrivacyPolicyEntry');
const { WorkspaceRouteBody } = await import('@/app/(app)/settings/voice/privacy');
const { SettingsAboutSection } = await import('@/components/settings/SettingsAboutSection');
const { useRouter } = await import('@/components/appShell/workspace/destinationRoute');
const { OVERVIEW_SETTINGS } = await import('@/components/settings/overview/overviewSettings');

function About() {
  const router = useRouter();
  return <SettingsAboutSection appVersion="test" handleGitHub={vi.fn()} handleVersionClick={vi.fn()}
    router={router} showChangelog={false} showRateUs={false} supportUs={null} />;
}

describe('Voice settings privacy policy entry', () => {
  it('opens the public privacy policy through the canonical external-URL opener', async () => {
    openUrl.mockClear();
    const { HAPPIER_PRIVACY_POLICY_URL } = await import('@/constants/legalUrls');
    const screen = await renderScreen(React.createElement(VoicePrivacyPolicyEntry));

    const entry = screen.findAll(node => node.props.testID === 'settings.voice.privacyPolicy'
      && typeof node.type === 'string' && typeof node.props.onPress === 'function')[0];
    expect(entry).toBeDefined();
    expect(screen.getTextContent()).toContain(t('settings.privacyPolicy'));

    // A row with an `onPress` is what makes `Item` render an interactive,
    // focusable, button-role control; a decorative row would not be reachable by
    // keyboard or a screen reader (§7.3).
    expect(typeof entry.props.onPress).toBe('function');
    expect(entry.props.accessibilityRole ?? entry.props.role).toBe('button');

    await screen.pressByTestIdAsync('settings.voice.privacyPolicy');
    expect(openUrl).toHaveBeenCalledWith(HAPPIER_PRIVACY_POLICY_URL);

    await screen.unmount();
  });

  it('mounts the policy after privacy controls and history in the actual Voice route body', async () => {
    const screen = await renderScreen(React.createElement(WorkspaceRouteBody));
    const destinations = screen.findAll(node => typeof node.type === 'string'
      && ['settings.voice.section.privacy', 'settings-voice-history-entry', 'settings.voice.privacyPolicy'].includes(node.props.testID));
    expect(destinations.map(node => node.props.testID)).toEqual([
      'settings.voice.section.privacy', 'settings-voice-history-entry', 'settings.voice.privacyPolicy',
    ]);
    await screen.pressByTestIdAsync('settings.voice.privacyPolicy');
    expect(openUrl).toHaveBeenCalled();
  });

  it('opens the same canonical public policy from About and Voice', async () => {
    const { HAPPIER_PRIVACY_POLICY_URL } = await import('@/constants/legalUrls');
    openUrl.mockClear();
    const screen = await renderScreen(React.createElement(About));
    const anchor = screen.findAll(node => typeof node.type === 'string'
      && node.props.nativeID === `setting-${OVERVIEW_SETTINGS.settings.privacyPolicy.anchor}`)[0];
    const policy = anchor?.findAll(node => typeof node.type === 'string' && typeof node.props.onPress === 'function')[0];
    expect(policy).toBeDefined();
    await act(async () => { await policy!.props.onPress(); });
    expect(openUrl).toHaveBeenCalledWith(HAPPIER_PRIVACY_POLICY_URL);
  });
});
