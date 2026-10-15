import type { ScmDiffArea } from '@happier-dev/protocol/scm';

export {
    SCM_GIT_REPO_BACKEND_OPTIONS, SCM_BACKEND_QUALIFIED_ID_MAX_LENGTH,
    normalizeScmGitRepoPreferredBackend, normalizeScmBackendQualifiedId,
    resolveScmGitRepoPreferredBackendId, buildScmGitRepoBackendPreferenceSettingsDelta,
    type ScmGitRepoPreferredBackend, type ScmGitRepoBackendPreferenceSettingsDelta,
} from '@happier-dev/protocol/scm';

export const SCM_REMOTE_CONFIRM_POLICIES = ['always', 'pull_only', 'push_only', 'never'] as const;
export type ScmRemoteConfirmPolicy = (typeof SCM_REMOTE_CONFIRM_POLICIES)[number];

export const SCM_PUSH_REJECT_POLICIES = ['prompt_fetch', 'auto_fetch', 'manual'] as const;
export type ScmPushRejectPolicy = (typeof SCM_PUSH_REJECT_POLICIES)[number];

export const SCM_DIFF_MODE_OPTIONS = ['included', 'pending', 'both'] as const satisfies readonly ScmDiffArea[];
export type ScmDefaultDiffMode = (typeof SCM_DIFF_MODE_OPTIONS)[number];
