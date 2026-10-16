import * as React from 'react';
import { Text } from 'react-native';
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
});
