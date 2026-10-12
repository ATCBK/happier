import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { describeScmChangeKind } from '@/scm/scmChangeKind';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { t } from '@/text';
import { formatHappierDiffStat } from '@happier-dev/plugin-ui/presentation';

/** The strings the changed-file row owns, before its name-first/inline composition. */
export function resolveScmChangeRowDisplayText(file: ScmFileStatus, nameFirst: boolean) {
    const { dir, name } = normalizeRepoPathParts(file);
    const complete = file.isComplete !== false;
    return {
        path: dir ? `${dir}/${name}` : name,
        mark: describeScmChangeKind(file.status).code,
        renamedFrom: nameFirst && file.status === 'renamed' && file.oldPath ? t('sessionGitPane.row.renamedFrom', { path: file.oldPath }) : null,
        unavailable: complete ? null : '—',
        added: complete ? formatHappierDiffStat(file.linesAdded, file.linesRemoved).added : null,
        removed: complete ? formatHappierDiffStat(file.linesAdded, file.linesRemoved).removed : null,
    };
}
