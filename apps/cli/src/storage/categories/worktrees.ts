import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { WORKTREE_RELATIVE_PARENT_DIR } from '@happier-dev/protocol/scm/worktreeName';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { directoriesAtDepth, check, item, unavailableDirectory, contains } from './filesystem';
import { StorageCategoryAdapterError, type StorageCategoryAdapter, type StorageCategoryDefinition, type StorageCategoryContext, type StorageCategoryCatalogDeps } from './types';
import { worktreeVerdict } from '../worktrees/worktreeVerdicts';

function roots(context: StorageCategoryContext) {
    const repos = [...context.projects.map(project => project.repositoryRoot), ...context.worktrees.map(worktree => worktree.repositoryRoot)];
    return [...new Set(repos)].map(root => join(root, WORKTREE_RELATIVE_PARENT_DIR));
}
const OwnerData = z.object({ v: z.literal(1), repositoryRoot: z.string().min(1), worktreePath: z.string().min(1),
    retentionSupported: z.boolean() }).strict();
const StoredOwnerData = createStoredReadSchema(OwnerData);
function adapter(raw: unknown, deps: StorageCategoryCatalogDeps): StorageCategoryAdapter {
    const parsed = StoredOwnerData.safeParse(raw);
    if (!parsed.success) throw new StorageCategoryAdapterError('owner_data_invalid');
    const data = parsed.data;
    const owner = deps.worktreeOperations;
    if (!owner) throw new StorageCategoryAdapterError('owner_unavailable');
    return {
        ownerData: data, restorable: data.retentionSupported, requiresIdle: true,
        async retire({ payloadPath, beforeEffect }) {
            if (!data.retentionSupported) throw new StorageCategoryAdapterError('restore_unsupported');
            await owner.retire({ repositoryRoot: data.repositoryRoot, worktreePath: data.worktreePath,
                targetPath: payloadPath, entryId: basename(dirname(payloadPath)), beforeEffect });
        },
        async reinstate({ payloadPath, restorePath, beforeEffect }) {
            if (!data.retentionSupported) throw new StorageCategoryAdapterError('restore_unsupported');
            await owner.reinstate({ repositoryRoot: data.repositoryRoot, worktreePath: payloadPath,
                targetPath: restorePath, entryId: basename(dirname(payloadPath)), beforeEffect });
        },
        async discard({ payloadPath, beforeEffect }) {
            await owner.remove({ repositoryRoot: data.repositoryRoot, worktreePath: payloadPath ?? data.worktreePath, beforeEffect });
        },
    };
}
export const worktrees: StorageCategoryDefinition = {
    id: 'worktrees', roots,
    async items(context) {
        const registered = new Map(context.worktrees.map(worktree => [worktree.path, worktree]));
        const paths = [...new Set([...registered.keys(), ...(await Promise.all(roots(context)
            .map(root => directoriesAtDepth(root, 1, unavailableDirectory(context, 'worktrees'))))).flat()])]
            .filter(path => !context.deps.trashRoots?.().some(root => contains(root, path)));
        const result = await Promise.all(paths.map(async path => {
            const worktree = registered.get(path);
            const projectIds = [...new Set(context.projects.filter(project => worktree
                ? canonicalAbsolutePathsEqual(project.repositoryRoot, worktree.repositoryRoot)
                : contains(join(project.repositoryRoot, WORKTREE_RELATIVE_PARENT_DIR), path))
                .flatMap(project => project.projectId ? [project.projectId] : []))].sort();
            if (!worktree) return { ...item('worktrees', path, check, { kind: 'worktree', evidence: ['worktree_parent', 'registration_unavailable'] }), projectIds };
            const sessions = context.sessions.filter(session => !session.archived && contains(path, session.cwd));
            const drafts = await Promise.all(sessions.map(session => context.deps.readSessionDraftPresence?.(session.sessionId)
                ?? Promise.resolve({ status: 'unknown' as const })));
            const draft = drafts.some(value => value.status === 'present') ? 'present' : drafts.some(value => value.status === 'unknown') ? 'unknown' : 'absent';
            const inUse = context.inUse.paths.some(live => contains(path, live)) || sessions.some(session => session.running);
            const verdict = worktreeVerdict({ isMain: worktree.isMain, inUse: inUse || (context.inUse.reliable ? false : 'unknown'),
                scm: worktree.facts, draft, pullRequest: worktree.pullRequestState === 'open' ? 'open'
                    : worktree.pullRequestState === undefined ? 'unknown' : 'none' });
            return { ...item('worktrees', path, verdict, { kind: 'worktree', ...(worktree.title ? { title: worktree.title } : {}),
                ...(worktree.facts?.lastActivityAt !== undefined ? { lastUsedAt: worktree.facts.lastActivityAt } : {}),
                evidence: ['scm_registered_worktree'] }), projectIds, repositoryRoot: worktree.repositoryRoot, fingerprintRequired: true,
                ...(worktree.fingerprint ? { fingerprint: worktree.fingerprint, ownFingerprint: worktree.fingerprint } : {}) };
        }));
        return result.map(parent => {
            const nested = result.filter(child => !canonicalAbsolutePathsEqual(parent.path, child.path) && contains(parent.path, child.path));
            if (!nested.length) return parent;
            const unsafe = nested.some(child => child.verdict !== 'safe');
            const unknown = nested.some(child => child.verdict === 'check');
            const knownFingerprints = parent.ownFingerprint && nested.every(child => child.fingerprint);
            const nestedVerdict = parent.verdict === 'keep' || parent.verdict === 'check' ? {}
                : unknown ? check
                    : unsafe ? { verdict: 'keep' as const, collectable: true,
                        reason: { code: 'contains' as const, detail: { count: nested.length } } } : {};
            return { ...parent, nestedWorktreePaths: nested.map(child => child.path),
                fingerprint: knownFingerprints ? `sha256:${createHash('sha256').update(JSON.stringify([parent.ownFingerprint,
                    nested.map(child => [child.path, child.fingerprint, child.verdict, child.reason]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])).digest('hex')}` : undefined,
                ...nestedVerdict,
                ...(unsafe ? { loses: [...(parent.loses ?? []), ...nested.flatMap(child => child.loses ?? [child.reason])] } : {}),
                evidence: [...parent.evidence, unsafe ? 'nested_worktree_kept' : 'nested_worktrees_children_first'] };
        });
    },
    async bindAdapter(value, context) {
        const worktree = context.worktrees.find(w => canonicalAbsolutePathsEqual(w.path, value.path));
        if (!worktree) throw new StorageCategoryAdapterError('owner_unavailable');
        return adapter({ v: 1, repositoryRoot: worktree.repositoryRoot, worktreePath: worktree.path,
            retentionSupported: worktree.retentionSupported === true && worktree.facts?.hasSubmodules === false }, context.deps);
    },
    async adapterForEntry(data, deps) { return adapter(data, deps); },
};
