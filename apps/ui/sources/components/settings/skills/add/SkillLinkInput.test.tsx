import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { CapabilityAddModalBody, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { SkillLinkInput } from './SkillLinkInput';
import { t } from '@/text';

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

/** The title of the found list's one group, as the Collection model carries it. */
function groupTitle(screen: { findAll: (predicate: (node: any) => boolean) => any[] }): string | undefined {
  const collection = screen.findAll((node) => node.props?.testID === 'skills.add:collection' && node.props?.model !== undefined)[0];
  return collection?.props.model.sections?.[0]?.group?.title;
}

type Callbacks = Readonly<{ onAdded?: (id: string) => void; onSelectAdded?: (id: string) => void; onDone?: () => void }>;

/**
 * The Link mode inside the real Add dialog body (the one list + details owner), as the Skills page opens it. Only the
 * Action transport (`execute`) and the device class are boundaries.
 */
async function renderLink(answer: MountedAuthoringActionExecute, callbacks: Callbacks = {}, link = 'https://github.com/acme/agent-skills') {
  const onClose = vi.fn();
  const inputContext: { current?: CapabilityAddInputContext } = {};
  const config = {
    title: 'Add a skill',
    testID: 'skills.add',
    initialModeKey: 'link',
    modes: [
      {
        key: 'link',
        label: 'From a link',
        icon: 'link' as const,
        kind: 'input' as const,
        ownsTools: true,
        renderBody: (ctx: CapabilityAddInputContext) => {
          inputContext.current = ctx;
          return (
            <SkillLinkInput
              ctx={ctx}
              execute={answer}
              onAdded={callbacks.onAdded ?? (() => {})}
              onSelectAdded={callbacks.onSelectAdded ?? (() => {})}
              onDone={callbacks.onDone ?? (() => {})}
              testID="link"
            />
          );
        },
      },
    ],
    catalog: { query: '', onQueryChange: () => {}, searchPlaceholder: '', items: [], itemKey: () => '', anatomy: {} , loading: false, empty: null },
    renderDetail: () => null,
    detailFooter: () => ({ primary: { label: '', onPress: async () => null } }),
  };
  const screen = await renderScreen(<CapabilityAddModalBody config={config as never} onClose={onClose} />);
  await act(async () => {
    screen.changeTextByTestId('link.url', link);
  });
  await screen.pressByTestIdAsync('link.find');
  /** Open a found row as its press does: through the Collection model's own open action. */
  const open = async (path: string) => {
    const collection = screen.findAll(
      (node) => node.props?.testID === 'skills.add:collection' && typeof node.props?.model?.actions?.open === 'function',
    )[0];
    if (!collection) throw new Error('collection not rendered');
    await act(async () => {
      collection.props.model.actions.open(path);
    });
  };
  const pressPrimary = async () => {
    const button = screen.findAll((node) => node.props?.testID === 'skills.add:primary' && typeof node.props?.onPress === 'function')[0];
    if (!button) throw new Error('primary is not pressable');
    await act(async () => {
      await button.props.onPress();
    });
  };
  /**
   * A found row's own slots (tick, In your library, facts), drawn from the Collection's real anatomy: the test
   * renderer's native Collection has no measured viewport to lay rows out in.
   */
  const row = async (item: Readonly<Record<string, unknown>>) => {
    const collection = screen.findAll((node) => node.props?.testID === 'skills.add:collection' && node.props?.anatomy)[0];
    if (!collection) throw new Error('collection not rendered');
    const anatomy = collection.props.anatomy;
    return renderScreen(<>{anatomy.leadingControl?.(item)}{anatomy.titleMeta?.(item)}{anatomy.byline?.(item)}</>);
  };
  // Native Collection layout is unmeasured here; use the input mode's public Back boundary.
  const closeDetail = async () => {
    const ctx = inputContext.current;
    if (!ctx) throw new Error('input context not rendered');
    await act(async () => ctx.openDetail(null));
  };
  return { screen, open, closeDetail, pressPrimary, row, onClose };
}

/** Finds a skill from a link, then tries to add it, so the footer carries a refusal beside Add. */
async function renderFailedAdd() {
  const { screen } = await renderLink(execute);
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
  it('shows each index item’s digest verification while keeping held identity, selection and the reviewed pins', async () => {
    const indexUrl = 'https://skills.example.test/.well-known/skills/index.json';
    const provenance = { kind: 'wellKnown' as const, indexUrl, name: 'grill-me', digest: `sha256:${'a'.repeat(64)}` };
    const held = { ...PREVIEW, path: 'grill-me', provenance, inLibrary: 'held-review' };
    const fresh = { ...PREVIEW, path: 'to-prd', name: 'to-prd', provenance: {
      ...provenance, name: 'to-prd', digest: `sha256:${'b'.repeat(64)}`, publishedDigest: `sha256:${'c'.repeat(64)}`,
    } };
    const installs: unknown[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      if ((input as { dryRun?: boolean }).dryRun) return { ok: true, result: { items: [held, fresh] } };
      installs.push(input);
      return { ok: true, result: { skillIds: ['new-prd'], includedInSessionId: null } };
    };
    const { screen, row, open, closeDetail } = await renderLink(answer, {}, indexUrl);
    const heldRow = await row(held);
    expect(heldRow.findByTestId('link.item.grill-me.inLibrary')).not.toBeNull();
    expect(heldRow.getTextContent()).toContain('skills.example.test');
    expect(heldRow.getTextContent()).toContain(t('capabilities.skillDetail.source.noDigestPublished'));
    const freshRow = await row(fresh);
    expect(freshRow.getTextContent()).toContain(t('capabilities.skillDetail.source.verifiedByDigest'));
    await open('to-prd');
    expect(screen.getTextContent()).toContain(t('capabilities.skillDetail.source.verifiedByDigest'));
    expect(screen.getTextContent()).not.toContain(PREVIEW.provenance.ref.commit.slice(0, 7));
    await closeDetail();
    // The footer uses the same multi-skill selection owner: the held item is never selected again.
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([{ source: { kind: 'link', url: indexUrl, refs: [held.provenance, fresh.provenance] }, selectPaths: ['to-prd'] }]);
  });

  it('treats a pasted skills add command as link text for both preview and install', async () => {
    const calls: unknown[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      calls.push(input);
      return (input as { dryRun?: boolean }).dryRun
        ? { ok: true, result: { items: [PREVIEW] } }
        : { ok: true, result: { skillIds: ['skill-new'], includedInSessionId: null } };
    };
    const { screen } = await renderLink(answer, {}, '  npx skills add https://github.com/acme/agent-skills  ');
    expect(calls[0]).toEqual({ source: { kind: 'link', url: 'https://github.com/acme/agent-skills' }, dryRun: true });
    await screen.pressByTestIdAsync('link.add');
    expect(calls).toEqual([
      { source: { kind: 'link', url: 'https://github.com/acme/agent-skills' }, dryRun: true },
      { source: { kind: 'link', url: 'https://github.com/acme/agent-skills', refs: [PREVIEW.provenance.ref] } },
    ]);
  });

  it('keeps every acknowledged skill and retries only the remaining sibling rules', async () => {
    const calls: { actionId: string; input: unknown }[] = [];
    let remainingFails = true;
    const onAdded = vi.fn();
    const answer: MountedAuthoringActionExecute = async (actionId, input) => {
      if (actionId === 'skills.install' && (input as { dryRun?: boolean }).dryRun)
        return { ok: true, result: { items: [PREVIEW] } };
      calls.push({ actionId, input });
      if (actionId === 'skills.install') return { ok: true, result: {
        skillIds: ['primary', 'sibling-a', 'sibling-b'], includedInSessionId: null,
        incomplete: [{ skillId: 'sibling-a', step: 'rules' }, { skillId: 'sibling-b', step: 'rules' }],
      } };
      const skillId = (input as { items: { skillId: string }[] }).items[0]!.skillId;
      if (skillId === 'sibling-b' && remainingFails) return { ok: true, result: { ok: false, code: 'settings_conflict' } };
      return { ok: true, result: { ok: true, revision: 2, items: [{ skillId, previous: [], rules: [] }] } };
    };
    const { screen } = await renderLink(answer, { onAdded });
    await screen.pressByTestIdAsync('link.add');
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.findByTestId('link.footer')).not.toBeNull();
    expect(screen.findByTestId('link.add-error')).not.toBeNull();
    await screen.pressByTestIdAsync('link.add');
    expect(onAdded).not.toHaveBeenCalled();
    remainingFails = false;
    await screen.pressByTestIdAsync('link.add');
    expect(onAdded).toHaveBeenCalledExactlyOnceWith('primary');
    expect(calls.map(call => call.actionId)).toEqual(['skills.install', 'skills.rules.set', 'skills.rules.set', 'skills.rules.set']);
    expect(calls.slice(1).map(call => call.input)).toEqual(['sibling-a', 'sibling-b', 'sibling-b'].map(skillId => ({
      items: [{ skillId }], change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } },
    })));
  });

  it('stacks the refusal above the actions on a phone, as the other Add modes do', async () => {
    device.current = 'phone';
    expect(footerDirection(await renderFailedAdd())).toBe('column');
  });

  it('keeps the refusal beside Add where the dialog is a card', async () => {
    expect(footerDirection(await renderFailedAdd())).toBe('row');
  });
});

describe('SkillLinkInput details (G8)', () => {
  const second = { ...PREVIEW, path: 'skills/to-prd', name: 'to-prd', description: 'Turn the talk into a PRD.',
    provenance: { ...PREVIEW.provenance, ref: { ...PREVIEW.provenance.ref, path: 'skills/to-prd', treeSha: 'c'.repeat(40) } } };
  const source = { kind: 'link', url: 'https://github.com/acme/agent-skills', refs: [PREVIEW.provenance.ref, second.provenance.ref] };
  async function renderPair() {
    const installs: Record<string, unknown>[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      if ((input as { dryRun?: boolean }).dryRun === true) return { ok: true, result: { items: [PREVIEW, second] } };
      installs.push(input as Record<string, unknown>);
      return { ok: true, result: { skillIds: ['skill-new'], includedInSessionId: null } };
    };
    const selected: string[] = [];
    const rendered = await renderLink(answer, { onSelectAdded: (id) => selected.push(id) });
    return { ...rendered, installs, selected };
  }

  it('opens a found row in the same details, with Where it\'s on, and adds only that skill with the Where picked', async () => {
    const { screen, open, pressPrimary, installs, selected, onClose } = await renderPair();
    await open('skills/to-prd');
    expect(screen.findByTestId('link.detail.title')).not.toBeNull();
    const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
    const where = screen.findByType(WhereItsOnControl);
    expect(where.props.presentation).toBe('pick');
    const narrowed = { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-1' }, state: 'on' } } as const;
    await act(async () => {
      await where.props.onChange(narrowed);
    });
    await pressPrimary();
    expect(installs).toEqual([
      { source, selectPaths: ['skills/to-prd'], where: narrowed },
    ]);
    expect(onClose).toHaveBeenCalled();
    expect(selected).toEqual(['skill-new']);
  });

  it('sends no Where from untouched details', async () => {
    const { open, pressPrimary, installs } = await renderPair();
    await open('skills/grill-me');
    await pressPrimary();
    expect(installs).toEqual([{ source, selectPaths: ['skills/grill-me'] }]);
  });

  it('ticks with the box, not the row, and the checklist footer adds the ticked set without a Where', async () => {
    const { screen, row, installs } = await renderPair();
    await (await row(PREVIEW)).pressByTestIdAsync('link.item.grill-me.tick');
    expect(screen.findByTestId('link.detail.title')).toBeNull();
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([{ source, selectPaths: ['skills/to-prd'] }]);
  });
});

describe('SkillLinkInput outside references', () => {
  async function renderFound(preview: Record<string, unknown>) {
    const answer: MountedAuthoringActionExecute = async () => ({
      ok: true,
      result: { items: [preview] },
    });
    const rendered = await renderLink(answer);
    await rendered.open(preview.path as string);
    return rendered.screen;
  }

  it('says in the details that referenced files will not come along, and still lets it be added', async () => {
    const screen = await renderFound({
      ...PREVIEW,
      outsideReferences: ['../../shared/checklist.md', '../lint.sh'],
    });
    expect(screen.findHostByTestId('link.detail.outsideReferences')).not.toBeNull();
    expect(screen.getTextContent()).toContain('2 files');
    expect(screen.findByTestId('link.add')?.props.disabled).not.toBe(true);
  });

  it('draws nothing for a skill whose references are all in its folder', async () => {
    const screen = await renderFound({ ...PREVIEW });
    expect(screen.findHostByTestId('link.detail.outsideReferences')).toBeNull();
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
    return { ...(await renderLink(answer)), installs };
  }

  it('names the sibling a ticked skill brings, and adds both', async () => {
    const { screen, row, installs } = await renderFoundPair();
    expect((await row(referrer)).getTextContent()).toContain('Also adds orm-setup, which it refers to');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([
      expect.objectContaining({ selectPaths: ['skills/prisma-cli', 'skills/orm-setup'] }),
    ]);
  });

  it('lets the sibling be unticked: its line goes and only the skill is added', async () => {
    const { screen, row, installs } = await renderFoundPair();
    await (await row(sibling)).pressByTestIdAsync('link.item.orm-setup.tick');
    expect((await row(referrer)).getTextContent()).not.toContain('Also adds orm-setup');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([expect.objectContaining({ selectPaths: ['skills/prisma-cli'] })]);
  });

  it('shows the kept sibling and the one file left outside in the details, and adds both from there', async () => {
    const { screen, open, pressPrimary, installs } = await renderFoundPair();
    await open('skills/prisma-cli');
    expect(screen.findHostByTestId('link.detail.sibling.orm-setup.alsoAdds')).not.toBeNull();
    expect(screen.getTextContent()).toContain('one file');
    await pressPrimary();
    expect(installs).toEqual([expect.objectContaining({ selectPaths: ['skills/prisma-cli', 'skills/orm-setup'] })]);
  });
});

describe('SkillLinkInput skills the library already holds', () => {
  const held = { ...PREVIEW, inLibrary: 'skill-held' };
  const fresh = { ...PREVIEW, path: 'skills/orm-setup', name: 'orm-setup', description: 'Set up the ORM.' };
  const heldSibling = { ...fresh, inLibrary: 'skill-orm' };
  // The Action drops a held sibling from `siblingSkills`, so its reference reads as outside unless the row covers it.
  const referrer = {
    ...PREVIEW,
    path: 'skills/prisma-cli',
    name: 'prisma-cli',
    outsideReferences: ['../orm-setup/SKILL.md'],
  };

  async function renderFound(items: readonly Record<string, unknown>[]) {
    const installs: unknown[] = [];
    const opened: string[] = [];
    const selected: string[] = [];
    const done: string[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      if ((input as { dryRun?: boolean }).dryRun === true) return { ok: true, result: { items } };
      installs.push(input);
      return { ok: true, result: { skillIds: ['skill-new'], includedInSessionId: null } };
    };
    const rendered = await renderLink(answer, {
      onAdded: (id) => opened.push(id),
      onSelectAdded: (id) => selected.push(id),
      onDone: () => done.push('done'),
    });
    return { ...rendered, installs, opened, selected, done };
  }

  it('marks a held skill In your library and the footer opens it instead of adding it again', async () => {
    const { screen, row, installs, opened } = await renderFound([held]);
    expect((await row(held)).findHostByTestId('link.item.grill-me.inLibrary')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('Add to library');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([]);
    expect(opened).toEqual(['skill-held']);
  });

  it('offers Done, not an ambiguous Open, when several roots are held and none is new', async () => {
    const { screen, installs, opened, done } = await renderFound([held, heldSibling]);
    expect(screen.getTextContent()).toContain('Done');
    // Nothing is left to choose, so no "Choose which to add" heading stands over held rows.
    expect(groupTitle(screen)).toBeUndefined();
    expect(screen.findByTestId('link.add')).toBeNull();
    await screen.pressByTestIdAsync('link.done');
    expect(done).toEqual(['done']);
    expect(opened).toEqual([]);
    expect(installs).toEqual([]);
  });

  it('shows a held sibling as held, not as an added dependency, and counts its reference as covered', async () => {
    const { screen, row, installs } = await renderFound([referrer, heldSibling]);
    expect((await row(heldSibling)).findHostByTestId('link.item.orm-setup.inLibrary')).not.toBeNull();
    expect((await row(heldSibling)).findByTestId('link.item.orm-setup.tick')?.props.disabled).toBe(true);
    expect((await row(referrer)).getTextContent()).not.toContain('Also adds');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([expect.objectContaining({ selectPaths: ['skills/prisma-cli'] })]);
  });

  it('adds only the roots that are new when some are held, and a held one\'s details open it by its returned id', async () => {
    const { screen, open, pressPrimary, installs, selected } = await renderFound([held, fresh]);
    expect(screen.getTextContent()).toContain('Add 1 skill');
    expect(groupTitle(screen)).toBe('Choose which to add');
    await screen.pressByTestIdAsync('link.add');
    expect(installs).toEqual([expect.objectContaining({ selectPaths: ['skills/orm-setup'] })]);
    await open('skills/grill-me');
    await pressPrimary();
    expect(selected).toEqual(['skill-held']);
  });
});
