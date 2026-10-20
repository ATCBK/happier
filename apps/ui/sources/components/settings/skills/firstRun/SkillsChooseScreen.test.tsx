import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { StyleSheet } from 'react-native';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/skills/choose',
      router: navigation,
    }).module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
installDisconnectedServerSocketBoundary();
const { SkillsChooseScreen } = await import('./SkillsChooseScreen');
const { resetPromptLibraryCatalogEngineForTests } =
  await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } =
  await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => {
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.clearAllMocks();
});

// Three skills that no rule has decided yet; two were used in sessions, most recent first.
const usage = {
  key: 'skill-usage' as const,
  value: { v: 1 as const, lastUsedAt: { 'release-notes': 200, pdf: 100 } },
};

const SEEDED = ['pdf', 'meeting-notes', 'release-notes'];

async function chooseHome(origin: string) {
  const home = await createSeededSkillsHome(origin, {
    skills: [{ id: 'pdf' }, { id: 'meeting-notes' }, { id: 'release-notes' }],
    records: [usage],
  });
  home.storage.getState().applyLocalSettings({ skillsFirstRunDecidedAt: null });
  return home;
}

function rowOrder(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  return ['release-notes', 'pdf', 'meeting-notes']
    .map((id) => ({ id, at: screen.getTextContent().indexOf(id) }))
    .sort((a, b) => a.at - b.at)
    .map((row) => row.id);
}

it('ranks used skills first and pre-ticks them, then Turn on writes Everywhere for exactly the ticked ones and lands home', async () => {
  const home = await chooseHome('https://skills-choose-turn-on.test');
  try {
    const screen = await renderScreen(<SkillsChooseScreen />);
    await vi.waitFor(
      () => expect(screen.findByTestId('skills.choose.turnOn')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(rowOrder(screen)).toEqual(['release-notes', 'pdf', 'meeting-notes']);
    expect(screen.getTextContent()).toContain('2 selected');
    // Untick one, tick the unused one: the write follows the person's ticks, not the defaults.
    await act(async () => screen.pressByTestId('skills.choose.pdf'));
    await act(async () => screen.pressByTestId('skills.choose.meeting-notes'));
    await act(async () => screen.pressByTestId('skills.choose.turnOn'));
    await vi.waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith('/settings/skills'),
    );
    const rules = home.catalog.read('skill-rules').value as {
      rules: readonly {
        skillId: string;
        enabled: boolean;
        target: { t: string };
      }[];
    };
    expect(
      rules.rules
        // The Account's first-party seed rule is not the person's choice; only library skills count.
        .filter((rule) => SEEDED.includes(rule.skillId) && rule.enabled && rule.target.t === 'allMachines')
        .map((rule) => rule.skillId)
        .sort(),
    ).toEqual(['meeting-notes', 'release-notes']);
    expect(rules.rules.some((rule) => rule.skillId === 'pdf')).toBe(false);
    expect(
      home.storage.getState().localSettings.skillsFirstRunDecidedAt,
    ).not.toBeNull();
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('Not now ends the moment on this device without writing a rule, and the page then says nothing waits', async () => {
  const home = await chooseHome('https://skills-choose-not-now.test');
  try {
    const screen = await renderScreen(<SkillsChooseScreen />);
    await vi.waitFor(
      () => expect(screen.findByTestId('skills.choose.notNow')).not.toBeNull(),
      { timeout: 10_000 },
    );
    await act(async () => screen.pressByTestId('skills.choose.notNow'));
    expect(navigation.push).toHaveBeenCalledWith('/settings/skills');
    expect(
      (home.catalog.read('skill-rules').value as { rules: readonly { skillId: string }[] })
        .rules.filter((rule) => SEEDED.includes(rule.skillId)),
    ).toEqual([]);
    await vi.waitFor(() =>
      expect(screen.findByTestId('skills.choose.nothingWaits')).not.toBeNull(),
    );
    expect(screen.findByTestId('skills.choose.bar')).toBeNull();
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('keeps Not now and Turn on above the phone tab bar that floats over the page', async () => {
  const home = await chooseHome('https://skills-choose-tab-bar.test');
  try {
    const barBottomPadding = async (chromeHeight: number) => {
      const screen = await renderScreen(
        <SessionCockpitBottomChromeHeightContext.Provider value={chromeHeight}>
          <SkillsChooseScreen />
        </SessionCockpitBottomChromeHeightContext.Provider>,
      );
      await vi.waitFor(() => expect(screen.findByTestId('skills.choose.turnOn')).not.toBeNull(), { timeout: 10_000 });
      return Number(StyleSheet.flatten(screen.findByTestId('skills.choose.bar')!.props.style)?.paddingBottom);
    };
    // The bar reserves exactly the floating bar's measured height on top of what it carries without one.
    expect((await barBottomPadding(84)) - (await barBottomPadding(0))).toBe(84);
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});
