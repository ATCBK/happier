import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks();

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
});
