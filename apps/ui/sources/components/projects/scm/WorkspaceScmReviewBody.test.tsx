import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowSize = vi.hoisted(() => ({ width: 1200 }));
// The window size is the platform boundary the pre-measure layout reads. The file-level mock serves
// the static imports; the helper re-registers react-native for later imports, so it gets the same one.
const mockReactNativeWithWindow = vi.hoisted(() => async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({ width: windowSize.width, height: 844, scale: 1, fontScale: 1 }),
  });
});
vi.mock('react-native', () => mockReactNativeWithWindow());
installNavigationCommonModuleMocks({ reactNative: mockReactNativeWithWindow });
// Install the navigation factory before either consumer loads react-native. A static
// import resolves the helper's default factory before its options have been configured.
const { Text } = await import('react-native');
const { renderScreen } = await import('@/dev/testkit');

describe('WorkspaceScmReviewBody', () => {
  it('offers no review actions while a state stands in for the files (not a repository, unreachable)', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const props = {
      comparison: null,
      view: 'files' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview: vi.fn(),
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: () => <Text testID="files">files</Text>,
      renderWalkthrough: () => null,
    };
    const withState = await renderScreen(
      <WorkspaceScmReviewBody
        {...props}
        filesState={<Text testID="not-a-repo">Not a repository</Text>}
      />,
    );
    expect(withState.findHostByTestId('not-a-repo')).not.toBeNull();
    // The bar keeps its place and its views; acting on files that are not there is not offered.
    expect(withState.findHostByTestId('scm-comparison-bar')).not.toBeNull();
    expect(
      withState.findHostByTestId('scm-comparison-start-review'),
    ).toBeNull();
    expect(withState.findHostByTestId('propose')).toBeNull();
  });

  it('offers no review actions when the comparison has no changes, and offers them again once it has some', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const props = {
      comparison: null,
      view: 'files' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview: vi.fn(),
      onProposeCommits: vi.fn(),
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: ({ renderBarLeading, barTrailing }: { renderBarLeading: (coverage: { fileCount: number; added: number; removed: number; linesKnown: boolean }) => React.ReactNode; barTrailing?: React.ReactNode }) => (
        <>{renderBarLeading({ fileCount: 0, added: 0, removed: 0, linesKnown: false })}{barTrailing}</>
      ),
      renderWalkthrough: () => null,
    };
    const empty = await renderScreen(<WorkspaceScmReviewBody {...props} fileCount={0} />);
    expect(empty.findHostByTestId('scm-comparison-start-review')).toBeNull();
    expect(empty.findHostByTestId('propose')).toBeNull();

    const changed = await renderScreen(<WorkspaceScmReviewBody {...props} fileCount={3} />);
    expect(changed.findHostByTestId('scm-comparison-start-review')).not.toBeNull();
    expect(changed.findHostByTestId('propose')).not.toBeNull();
  });

  it('puts a review\'s status in Start review\'s place on the wide bar and keeps Start review one choice away in the menu', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const onStartReview = vi.fn();
    const props = {
      comparison: null,
      view: 'walkthrough' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview,
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: () => null,
    };
    const unreviewed = await renderScreen(
      <WorkspaceScmReviewBody {...props} renderWalkthrough={({ renderBar }) => renderBar(null)} />,
    );
    expect(unreviewed.findHostByTestId('scm-comparison-start-review')).not.toBeNull();

    const reviewed = await renderScreen(
      <WorkspaceScmReviewBody {...props}
        renderWalkthrough={({ renderBar }) => renderBar(null, undefined, <Text testID="review-status">Reviewed · 6 findings</Text>)} />,
    );
    expect(reviewed.findHostByTestId('review-status')).not.toBeNull();
    expect(reviewed.findHostByTestId('propose')).not.toBeNull();
    expect(reviewed.findHostByTestId('scm-comparison-start-review')).toBeNull();
    const menu = reviewed.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-more-menu');
    const row = (menu.props.items as Array<{ id: string; testID?: string }>).find((item) => item.testID === 'scm-comparison-start-review');
    expect(row).toBeDefined();
    await act(async () => { menu.props.onSelect(row!.id); });
    expect(onStartReview).toHaveBeenCalledTimes(1);
  });

  it.each([
    { window: 390, expected: 'phone' },
    { window: 1440, expected: 'narrow' },
  ])('lays a $window px window out as $expected before the body is measured', async ({ window, expected }) => {
    windowSize.width = window;
    try {
      const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
      const layouts: string[] = [];
      await renderScreen(
        <WorkspaceScmReviewBody comparison={null} view="walkthrough" scopeLabel="Pending changes" scopeOptions={[]}
          onSelectComparison={vi.fn()} onSelectView={vi.fn()} explain={false} onExplainChange={vi.fn()}
          renderFiles={() => null}
          renderWalkthrough={({ layout }) => { layouts.push(layout); return null; }} />,
      );
      // A phone never draws the wide reading first (it did after Retry at 390); a wide window waits for its measure.
      expect(layouts.length).toBeGreaterThan(0);
      expect(new Set(layouts)).toEqual(new Set([expected]));
    } finally {
      windowSize.width = 1200;
    }
  });
});
