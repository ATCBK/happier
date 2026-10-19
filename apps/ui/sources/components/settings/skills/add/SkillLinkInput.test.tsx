import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// The device class is a platform adapter boundary; the Add dialog is a phone page only on a phone.
const device = vi.hoisted(() => ({ current: 'tablet' as 'phone' | 'tablet' }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => device.current };
});

afterEach(() => {
  standardCleanup();
  device.current = 'tablet';
});

const PREVIEW = {
  path: 'skills/grill-me',
  name: 'grill-me',
  description: 'Interview the plan until every branch is decided.',
  files: [],
  trust: 'text_only',
  cost: { descriptionTokens: 20, bodyTokens: 300 },
  provenance: {
    kind: 'link',
    url: 'https://github.com/acme/agent-skills',
    ref: {
      kind: 'gitTree',
      repo: 'acme/agent-skills',
      path: 'skills/grill-me',
      commit: '49dd158aa1b2c3d4e5f60718293a4b5c6d7e8f90',
      treeSha: 'b'.repeat(40),
    },
  },
} as const;

/** The Action transport is the boundary: the preview finds one skill, the add itself is refused. */
const execute: MountedAuthoringActionExecute = async (_actionId, input) => {
  const dryRun = (input as { dryRun?: boolean }).dryRun === true;
  const answer: ActionExecuteResult = dryRun
    ? { ok: true, result: { items: [PREVIEW] } }
    : { ok: false, error: 'install failed', errorCode: 'skill_install_failed' };
  return answer;
};

/** Finds a skill from a link, then tries to add it, so the footer carries a refusal beside Add. */
async function renderFailedAdd() {
  const { SkillLinkInput } = await import('./SkillLinkInput');
  const screen = await renderScreen(
    <SkillLinkInput execute={execute} onAdded={() => {}} testID="link" />,
  );
  await act(async () => {
    screen.changeTextByTestId('link.url', 'https://github.com/acme/agent-skills');
  });
  await screen.pressByTestIdAsync('link.find');
  await screen.pressByTestIdAsync('link.add');
  return screen;
}

function footerDirection(screen: Awaited<ReturnType<typeof renderFailedAdd>>) {
  const footer = screen.findByTestId('link.footer');
  if (!footer) throw new Error('the Link footer is not rendered');
  return (
    [footer.props.style].flat(Infinity) as ReadonlyArray<
      { flexDirection?: string } | null | undefined
    >
  )
    .map((style) => style?.flexDirection)
    .filter(Boolean)
    .pop();
}

describe('SkillLinkInput footer', () => {
  it('stacks the refusal above the actions on a phone, as the other Add modes do', async () => {
    device.current = 'phone';
    expect(footerDirection(await renderFailedAdd())).toBe('column');
  });

  it('keeps the refusal beside Add where the dialog is a card', async () => {
    expect(footerDirection(await renderFailedAdd())).toBe('row');
  });
});

describe('SkillLinkInput outside references', () => {
  async function renderFound(preview: Record<string, unknown>) {
    const answer: MountedAuthoringActionExecute = async () => ({
      ok: true,
      result: { items: [preview] },
    });
    const { SkillLinkInput } = await import('./SkillLinkInput');
    const screen = await renderScreen(
      <SkillLinkInput execute={answer} onAdded={() => {}} testID="link" />,
    );
    await act(async () => {
      screen.changeTextByTestId('link.url', 'https://github.com/acme/agent-skills');
    });
    await screen.pressByTestIdAsync('link.find');
    return screen;
  }

  it('says on the found row that referenced files will not come along, and still lets it be added', async () => {
    const screen = await renderFound({
      ...PREVIEW,
      outsideReferences: ['../../shared/checklist.md', '../lint.sh'],
    });
    const note = screen.findHostByTestId('link.item.grill-me.outsideReferences');
    expect(note).not.toBeNull();
    expect(screen.getTextContent()).toContain('2 files');
    expect(screen.findByTestId('link.add')?.props.disabled).not.toBe(true);
  });

  it('draws nothing for a skill whose references are all in its folder', async () => {
    const screen = await renderFound({ ...PREVIEW });
    expect(screen.findHostByTestId('link.item.grill-me.outsideReferences')).toBeNull();
  });
});

describe('SkillLinkInput referenced siblings', () => {
  const sibling = { ...PREVIEW, path: 'skills/orm-setup', name: 'orm-setup', description: 'Set up the ORM.' };
  const referrer = {
    ...PREVIEW,
    path: 'skills/prisma-cli',
    name: 'prisma-cli',
    outsideReferences: ['../orm-setup/SKILL.md', '../README.md'],
    siblingSkills: [{ path: 'skills/orm-setup', references: ['../orm-setup/SKILL.md'] }],
  };

  async function renderFoundPair() {
    const installs: unknown[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      const dryRun = (input as { dryRun?: boolean }).dryRun === true;
      if (dryRun) return { ok: true, result: { items: [referrer, sibling] } };
      installs.push(input);
      return { ok: true, result: { skillIds: ['skill-1'], includedInSessionId: null } };
    };
    const { SkillLinkInput } = await import('./SkillLinkInput');
    const screen = await renderScreen(<SkillLinkInput execute={answer} onAdded={() => {}} testID="link" />);
    await act(async () => {
      screen.changeTextByTestId('link.url', 'https://github.com/acme/agent-skills');
    });
    await screen.pressByTestIdAsync('link.find');
    return { screen, installs };
  }

  it('names the sibling a ticked skill brings, leaves only the other file as the warning, and adds both', async () => {
    const { screen, installs } = await renderFoundPair();
    expect(screen.findHostByTestId('link.item.prisma-cli.sibling.skills/orm-setup')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Also adds orm-setup, which prisma-cli refers to');
    expect(screen.getTextContent()).toContain('one file');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([
      expect.objectContaining({ selectPaths: ['skills/prisma-cli', 'skills/orm-setup'] }),
    ]);
  });

  it('lets the sibling be unticked: its line goes, the reference counts as left behind, and only the skill is added', async () => {
    const { screen, installs } = await renderFoundPair();
    await screen.pressByTestIdAsync('link.item.orm-setup');
    expect(screen.findHostByTestId('link.item.prisma-cli.sibling.skills/orm-setup')).toBeNull();
    expect(screen.getTextContent()).toContain('2 files');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([expect.objectContaining({ selectPaths: ['skills/prisma-cli'] })]);
  });
});
