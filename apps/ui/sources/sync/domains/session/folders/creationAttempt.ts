import { randomUUID } from '@/platform/randomUUID';

import { normalizeSessionFolderName } from './names';
import type { SessionFolderWorkspaceRefV1 } from './types';
import {
    buildSessionFolderWorkspaceRefKey,
    normalizeSessionFolderWorkspaceRef,
} from './workspaceRefs';

export type SessionFolderCreationAttempt = Readonly<{
    key: string;
    id: string;
}>;

type SessionFolderCreationAttemptOutcome =
    | 'succeeded'
    | 'retryable-failure'
    | 'non-retryable-failure'
    | 'cancelled';

function buildSessionFolderCreationAttemptKey(input: Readonly<{
    workspace: SessionFolderWorkspaceRefV1;
    parentId: string | null;
    name: string;
}>): string {
    const workspace = normalizeSessionFolderWorkspaceRef(input.workspace);
    if (!workspace) throw new Error('Session folder creation workspace is invalid');
    return JSON.stringify([
        buildSessionFolderWorkspaceRefKey(workspace),
        input.parentId?.trim() || null,
        normalizeSessionFolderName(input.name) ?? 'Folder',
    ]);
}

export function acquireSessionFolderCreationAttempt(input: Readonly<{
    current: SessionFolderCreationAttempt | null;
    workspace: SessionFolderWorkspaceRefV1;
    parentId: string | null;
    name: string;
    createId?: () => string;
}>): SessionFolderCreationAttempt {
    const key = buildSessionFolderCreationAttemptKey(input);
    if (input.current?.key === key) return input.current;
    const id = (input.createId ?? randomUUID)().trim();
    if (!id) throw new Error('Session folder creation identity is unavailable');
    return { key, id };
}

export function settleSessionFolderCreationAttempt(
    attempt: SessionFolderCreationAttempt,
    outcome: SessionFolderCreationAttemptOutcome,
): SessionFolderCreationAttempt | null {
    return outcome === 'retryable-failure' ? attempt : null;
}
