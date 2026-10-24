import { normalizeRepositoryFilePath, type TurnChangeSet } from '@happier-dev/protocol';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import type {
    RepositoryCheckpointDiffResult,
    RepositoryCheckpointReceipt,
} from './types';

type TurnRepositoryCheckpoint = NonNullable<TurnChangeSet['repositoryCheckpoint']>;

function toProtocolReceipts(receipts: readonly RepositoryCheckpointReceipt[]): TurnRepositoryCheckpoint['receipts'] {
    return receipts.map((receipt) => ({
        id: receipt.id,
        ...(receipt.ref ? { ref: receipt.ref } : {}),
        ...(receipt.commitSha ? { commitSha: receipt.commitSha } : {}),
        ...(receipt.treeSha ? { treeSha: receipt.treeSha } : {}),
        ...(receipt.phase ? { phase: receipt.phase } : {}),
        ...(typeof receipt.prunedCount === 'number' ? { prunedCount: receipt.prunedCount } : {}),
        ...(receipt.refs ? { refs: [...receipt.refs] } : {}),
    }));
}

export function projectRepositoryCheckpointTurnChangeSet(params: Readonly<{
    providerTurnChangeSet: TurnChangeSet;
    checkpointDiff: RepositoryCheckpointDiffResult;
    repoRootPath: string;
    scopeId: string;
    startRef?: string;
    finalRef?: string;
}>): TurnChangeSet {
    const repositoryCheckpoint: TurnRepositoryCheckpoint = {
        version: 1,
        scopeId: params.scopeId,
        ...(params.startRef ? { startRef: params.startRef } : {}),
        ...(params.finalRef ? { finalRef: params.finalRef } : {}),
        baseRefSource: params.checkpointDiff.success
            ? params.checkpointDiff.baseRefSource
            : params.checkpointDiff.baseRefSource,
        contentConfidence: params.checkpointDiff.contentConfidence,
        attributionScope: params.checkpointDiff.attributionScope,
        receipts: toProtocolReceipts(params.checkpointDiff.receipts),
        ...(!params.checkpointDiff.success ? { unavailableReason: params.checkpointDiff.reason } : {}),
    };

    const repoRootPath = expandHomeDirPath(params.repoRootPath.trim());
    const normalizePath = (path: string) => normalizeRepositoryFilePath(expandHomeDirPath(path.trim()), repoRootPath);
    const files = params.checkpointDiff.success
        ? [...params.providerTurnChangeSet.files, ...params.checkpointDiff.files]
        : params.providerTurnChangeSet.files;

    return {
        ...params.providerTurnChangeSet,
        // Keep selectable evidence from both sources. Their shared repository identity,
        // not the provider's absolute spelling, keys the existing content/stat merger.
        files: files.map((file) => {
            const filePath = normalizePath(file.filePath);
            const previousFilePath = typeof file.previousFilePath === 'string' ? normalizePath(file.previousFilePath) : file.previousFilePath;
            if (filePath === file.filePath && previousFilePath === file.previousFilePath) return file;
            return { ...file, filePath, ...(typeof previousFilePath === 'string' ? { previousFilePath } : {}) };
        }),
        repositoryCheckpoint,
    };
}
