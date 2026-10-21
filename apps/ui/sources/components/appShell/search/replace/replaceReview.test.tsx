import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { WorkspaceReplaceModel } from '@/sync/domains/workspaces/files/workspaceFileReplace';

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
const { ReplaceResultSummary } = await import('./replaceReview');
const { t } = await import('@/text');

afterEach(async () => {
  await standardCleanup();
});

// The model's typed answer is the input; only the fields the result line reads are set.
function replacedModel(
  applyError: WorkspaceReplaceModel['applyError'],
): WorkspaceReplaceModel {
  return {
    results: [
      {
        path: 'src/retry.ts',
        status: 'replaced',
        matchCount: 3,
        hash: 'h',
        edits: [],
      },
    ],
    applyError,
    approval: null,
    preview: null,
    totals: { selectedFiles: 1 },
    canUndo: true,
    undoing: false,
    undo: () => undefined,
  } as unknown as WorkspaceReplaceModel;
}

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  return screen.tree
    .findAll((node) => typeof node.props?.label === 'string')
    .map((node) => node.props.label as string);
}

describe('ReplaceResultSummary', () => {
  it('says an Undo refused before writing did not run, and that the files keep the replacement', async () => {
    const screen = await renderScreen(
      <ReplaceResultSummary
        model={replacedModel('unavailable')}
        machineLabel="MacBook Pro"
      />,
    );
    expect(texts(screen)).toContain(
      t('universalSearch.replace.undoDidntRun', { machine: 'MacBook Pro' }),
    );
    expect(texts(screen)).not.toContain(
      t('universalSearch.replace.undoFailed', { machine: 'MacBook Pro' }),
    );
  });

  it('keeps the generic failure for an Undo that ran but could not restore every file', async () => {
    const screen = await renderScreen(
      <ReplaceResultSummary
        model={replacedModel('failed')}
        machineLabel="MacBook Pro"
      />,
    );
    expect(texts(screen)).toContain(
      t('universalSearch.replace.undoFailed', { machine: 'MacBook Pro' }),
    );
  });
});
