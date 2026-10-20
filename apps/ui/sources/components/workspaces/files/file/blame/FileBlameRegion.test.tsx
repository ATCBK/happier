import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmBlameFileResponse } from '@happier-dev/protocol/scm';

import {
  findAllHostTestInstances,
  pressTestInstance,
  renderHook,
} from '@/dev/testkit';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import {
  BlameCard,
  useFileBlameRegion,
  type FileBlameRegionInput,
} from './FileBlameRegion';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { blame } = vi.hoisted(() => ({ blame: vi.fn() }));
// The Machine RPC is the external boundary; run derivation and the region's cells stay real.
vi.mock('@/sync/ops/machineScmBlame', () => ({ machineScmBlameFile: blame }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

const committed: ScmBlameFileResponse = {
  success: true,
  commits: [
    {
      sha: 'c'.repeat(40),
      shortSha: 'ccccccc',
      authorName: 'Maya Chen',
      authoredAtMs: Date.now() - 5 * 86_400_000,
      summary: 'Type settings routes',
    },
  ],
  ranges: [
    { startLine: 1, lineCount: 2, commitIndex: 0 },
    { startLine: 3, lineCount: 1, commitIndex: null },
  ],
};
const input: FileBlameRegionInput = {
  scope: {
    machineId: 'machine',
    rootPath: '/repo',
    serverId: 'home',
    accountId: 'alice',
  },
  path: 'src/a.ts',
  content: { text: 'one\ntwo\nthree\n', hash: 'a'.repeat(64) },
  enabled: true,
  readBlame: true,
  sessionAddress: null,
  compact: false,
};
const line = (newLine: number | null): CodeLine =>
  ({
    id: `l${newLine}`,
    kind: 'file',
    oldLine: null,
    newLine,
    renderCodeText: '',
    renderPrefixText: '',
    renderIsHeaderLine: false,
  }) as unknown as CodeLine;

beforeEach(() => {
  blame.mockReset();
  blame.mockResolvedValue(committed);
});

describe('useFileBlameRegion', () => {
  it('adds no column and asks nothing while blame is off', async () => {
    const hook = await renderHook(() =>
      useFileBlameRegion({ ...input, enabled: false }),
    );
    expect(hook.getCurrent().renderLeadingLane).toBeUndefined();
    expect(blame).not.toHaveBeenCalled();
  });

  it('labels the first line of each run and opens its card from the run', async () => {
    const hook = await renderHook(() => useFileBlameRegion(input));
    const lane = hook.getCurrent().renderLeadingLane!;
    expect(lane).toBeDefined();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <>
          {lane(line(1))}
          {lane(line(2))}
          {lane(line(3))}
          {lane(line(null))}
        </>,
      );
    });
    // One labelled cell per run (the commit run and the uncommitted line); continuation lines stay quiet.
    expect(findAllHostTestInstances(tree.root, (node) => node.props.testID === 'blame-run:1')).toHaveLength(1);
    expect(findAllHostTestInstances(tree.root, (node) => node.props.testID === 'blame-run:2')).toHaveLength(0);
    expect(findAllHostTestInstances(tree.root, (node) => node.props.testID === 'blame-run:3')).toHaveLength(1);
    expect(hook.getCurrent().card).toBeNull();
    await act(async () => {
      pressTestInstance(findAllHostTestInstances(tree.root, (node) => node.props.testID === 'blame-run:1')[0]);
    });
    await hook.rerender();
    expect(hook.getCurrent().card).not.toBeNull();
  });

  it('says once that an untracked file has no history', async () => {
    blame.mockResolvedValue({
      success: false,
      errorCode: 'untracked',
      error: 'untracked',
    });
    const hook = await renderHook(() => useFileBlameRegion(input));
    expect(hook.getCurrent().note).toEqual({
      tone: 'info',
      text: 'files.blame.noHistory',
    });
  });
});

describe('BlameCard', () => {
  it('names the commit and offers Open commit only when the page can open one', async () => {
    const run = {
      id: 'r',
      kind: 'commit' as const,
      startLine: 6,
      lineCount: 6,
      label: 'Maya Chen',
      ageMs: 1000,
      commit: committed.success ? committed.commits![0]! : null!,
    };
    const onOpenCommit = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <BlameCard
          run={run}
          nowMs={Date.now()}
          agentId={null}
          onOpenCommit={onOpenCommit}
          onClose={() => {}}
        />,
      );
    });
    expect(JSON.stringify(tree.toJSON())).toContain('Type settings routes');
    expect(JSON.stringify(tree.toJSON())).toContain('files.blame.openCommit');
    await act(async () => {
      tree.update(
        <BlameCard
          run={run}
          nowMs={Date.now()}
          agentId={null}
          onClose={() => {}}
        />,
      );
    });
    expect(JSON.stringify(tree.toJSON())).not.toContain(
      'files.blame.openCommit',
    );
  });
});
