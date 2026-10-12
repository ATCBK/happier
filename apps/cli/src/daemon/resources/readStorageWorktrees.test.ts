import { expect, it } from 'vitest';
import type { ScmPullRequestState, ScmPullRequestStatusProjection } from '@happier-dev/protocol/scm';
import { readStorageWorktreePullRequestState } from './readStorageWorktrees';

it('retains draft reviews and preserves unknown hosting evidence instead of confirming no open review', () => {
    const status = (state: ScmPullRequestState | null, authState: ScmPullRequestStatusProjection['authState'] = 'authenticated'): ScmPullRequestStatusProjection => ({
        provider: null, baseBranch: 'main', headBranch: 'feature', authState,
        openPullRequest: state === null ? null : { provider: { id: 'fixture', kind: 'custom', displayName: 'Fixture',
            baseUrl: 'https://example.invalid', urlSafety: { allowedSchemes: ['https:'] } },
            title: 'Review', url: 'https://example.invalid/review/1', baseBranch: 'main', headBranch: 'feature', state },
    });
    expect(readStorageWorktreePullRequestState(status('draft'))).toBe('open');
    expect(readStorageWorktreePullRequestState(status('open'))).toBe('open');
    expect(readStorageWorktreePullRequestState(status('unknown'))).toBeUndefined();
    expect(readStorageWorktreePullRequestState(status(null, 'unknown'))).toBeUndefined();
    expect(readStorageWorktreePullRequestState(undefined)).toBeUndefined();
    expect(readStorageWorktreePullRequestState(status(null))).toBeNull();
    expect(readStorageWorktreePullRequestState(status(null, 'unsupported'))).toBeNull();
    expect(readStorageWorktreePullRequestState(status('closed'))).toBe('closed');
    expect(readStorageWorktreePullRequestState(status('merged'))).toBe('merged');
});
