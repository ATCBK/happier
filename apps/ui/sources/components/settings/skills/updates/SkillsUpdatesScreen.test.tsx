import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/skills/updates',
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
const { SkillsUpdatesScreen } = await import('./SkillsUpdatesScreen');
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

const SKILL_MD =
  '---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\n# Release notes\n';

it('takes a waiting update the person never changed: View changes shows both sides, Update stores the source version and leaves a receipt', async () => {
  const latest = '2'.repeat(40);
  const mineText = `${SKILL_MD}\nLead with user-visible changes.\n`;
  const upstreamText = `${SKILL_MD}\nGroup changes by area.\n`;
  const upstream = createPromptRegistrySkillFixture({
    sourceId: 'link',
    itemId: 'review',
    title: 'release-notes',
    files: [{ path: 'SKILL.md', content: upstreamText }],
  });
  if (upstream.item.payload.kind !== 'skill')
    throw new Error('Expected a skill fixture');
  const skill = upstream.item.payload.skill;
  const ref = { ...skill.ref, commit: latest };
  // GitHub is the external boundary: the newer tree and its one file.
  const github = async (request: string) => {
    if (request === 'https://api.github.com/repos/fixture/skills')
      return Response.json({ name: 'skills', default_branch: 'main' });
    if (request.includes('/commits/')) return Response.json({ sha: latest });
    if (request.includes('/git/trees/'))
      return Response.json({
        sha: ref.treeSha,
        tree: [
          { path: 'review', type: 'tree', mode: '040000', sha: ref.treeSha },
          ...skill.files.map((file) => ({
            path: `review/${file.path}`,
            type: 'blob',
            mode: '100644',
            sha: file.blobSha,
            size: file.size,
          })),
        ],
      });
    if (request.endsWith('/review/SKILL.md')) return new Response(upstreamText);
    return new Response(null, { status: 404 });
  };
  const home = await createSeededSkillsHome(
    'https://skills-updates-ready.test',
    {
      handleExternalRequest: github,
      skills: [
        {
          id: 'release-notes',
          text: mineText,
          unmodified: true,
          header: {
            skillLock: {
              provenance: {
                kind: 'link',
                url: 'https://github.com/fixture/skills',
                ref: {
                  ...ref,
                  commit: '1'.repeat(40),
                  treeSha: '4'.repeat(40),
                },
              },
              updatePolicy: 'manual',
              upstream: { state: 'update_available', latest: ref },
            },
          },
        },
      ],
    },
  );
  try {
    const screen = await renderScreen(<SkillsUpdatesScreen />);
    await vi.waitFor(
      () =>
        expect(
          screen.findByTestId('skills.updates.ready.release-notes'),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.findByTestId('skills.updates.upToDate')).toBeNull();
    await act(async () =>
      screen.pressByTestId('skills.updates.ready.release-notes.view'),
    );
    await vi.waitFor(() => {
      const changes = screen.findByTestId('skills.updates.ready.release-notes.changes');
      expect(changes).not.toBeNull();
      const text = changes!.findAll(node => typeof node.type === 'string')
        .flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
      const yoursIndex = text.indexOf('Yours');
      const theirsIndex = text.indexOf('Theirs');
      expect(yoursIndex).toBeGreaterThanOrEqual(0);
      expect(theirsIndex).toBeGreaterThan(yoursIndex);
      const yours = text.slice(yoursIndex, theirsIndex);
      const theirs = text.slice(theirsIndex);
      expect(yours).toContain('Lead with user-visible changes.');
      expect(yours).not.toContain('Group changes by area.');
      expect(theirs).toContain('Group changes by area.');
      expect(theirs).not.toContain('Lead with user-visible changes.');
    });
    await act(async () =>
      screen.pressByTestId('skills.updates.ready.release-notes.update'),
    );
    await vi.waitFor(
      () =>
        expect(home.boundary.readPlainBody('release-notes')).toContain(
          Buffer.from(upstreamText).toString('base64'),
        ),
      { timeout: 10_000 },
    );
    // The receipt stays on the page with the version taken; the actions are gone.
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('skills.updates.ready.release-notes.update'),
      ).toBeNull(),
    );
    expect(
      screen.findByTestId('skills.updates.ready.release-notes'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(latest.slice(0, 7));
    // With only the receipt left, the group says what happened instead of promising a safe update.
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Ready to update'));
    expect(screen.getTextContent()).toContain('Updated');
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('says when no skill comes from a source that can update, and offers no check that means nothing', async () => {
  const home = await createSeededSkillsHome(
    'https://skills-updates-unsourced.test',
    { skills: [{ id: 'meeting-notes' }] },
  );
  try {
    const screen = await renderScreen(<SkillsUpdatesScreen />);
    await vi.waitFor(
      () =>
        expect(screen.findByTestId('skills.updates.upToDate')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.getTextContent()).toContain(
      'None of your skills come from a source that updates',
    );
    expect(screen.getTextContent()).not.toContain('Everything is up to date');
    expect(screen.findByTestId('skills.updates.checkNow')?.props.disabled).toBe(
      true,
    );
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});
