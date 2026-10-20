import { parseGitComparisonOutput as parseSharedGitComparisonOutput } from '@happier-dev/cli-common/scm/gitComparisonOutput';

export type GitFileLineage = Readonly<{
    path: string;
    previousPath?: string;
    changeKind: 'added' | 'deleted' | 'renamed' | 'copied' | 'modified' | 'unknown';
    beforeBlobId?: string;
    afterBlobId?: string;
}>;

export const parseGitComparisonOutput: (output: string) => Readonly<{
    files: readonly GitFileLineage[]; sections: readonly string[]; error?: string;
}> = parseSharedGitComparisonOutput;
