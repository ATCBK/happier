import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getHappierTempRoot, getHappierTempDirOwnerPath, readHappierTempDirOwner, readHappierTempDirOwnerLiveness } from '@happier-dev/cli-common/tempDirs';
import { check, directoriesAtDepth, entries, exists, inUse, isInUse, item, listedEntryStat, newestChange, safe, unavailableDirectory, opaqueItemTitle } from './filesystem';
import type { StorageCategoryContext, StorageCategoryDefinition, StorageCategoryVerdict } from './types';
import { filesystemCategoryAdapters } from './filesystemAdapters';

function scopedRoots(context: StorageCategoryContext): readonly string[] {
    const server = context.deps.activeServerDir;
    return [join(server, 'composer-media-stages'), join(server, 'session-handoff'), join(server, 'runtime', 'scm')];
}
export async function temporaryCanGo(path: string, context: StorageCategoryContext, legacy = false): Promise<StorageCategoryVerdict> {
    if (isInUse(path, context)) return inUse;
    const owner = readHappierTempDirOwner(path);
    if (owner) {
        const liveness = readHappierTempDirOwnerLiveness(owner);
        if (liveness === 'alive') return inUse;
        if (owner.purpose === 'filesystem-copy-destination' || owner.purpose === 'runtime-build') {
            const state = context.temporaryFacts.find(fact => fact.path === path)?.state;
            return state === 'closed' ? { ...safe, reason: { code: 'stopped' } }
                : { verdict: 'keep', reason: { code: 'not_rebuildable' }, collectable: true, loses: [{ code: 'not_rebuildable' }] };
        }
        return liveness === 'gone' ? { ...safe, reason: { code: 'stopped' } } : check;
    }
    // Only direct legacy happier-* directories have the pre-boot cleanup contract. A modern
    // missing/broken marker is unavailable ownership, not evidence that its process exited.
    if (!legacy || await exists(getHappierTempDirOwnerPath(path))) return check;
    const uid = process.getuid?.();
    const legacyStat = await listedEntryStat(path, unavailableDirectory(context, 'temporary'));
    // The OS prefix cannot prove another user's custody. Legacy Windows paths have no
    // marker/ACL ownership proof; new Windows paths use the canonical secure creator.
    if (!legacyStat || uid === undefined || legacyStat.uid !== uid || legacyStat.isSymbolicLink()) return check;
    const changedAt = await newestChange(path);
    return context.deps.bootedAt !== undefined && changedAt !== null && changedAt < context.deps.bootedAt
        ? { ...safe, reason: { code: 'old' } } : check;
}
export const temporary: StorageCategoryDefinition = {
    ...filesystemCategoryAdapters,
    id: 'temporary',
    roots: context => [getHappierTempRoot(context.deps.tempRoot), ...scopedRoots(context),
        ...(context.deps.installDir ? [join(context.deps.installDir, '.tmp')] : [])],
    async items(context) {
        const result = [];
        const tempParent = context.deps.tempRoot ?? tmpdir();
        const markedRoot = getHappierTempRoot(tempParent);
        const denied = unavailableDirectory(context, 'temporary');
        // An unavailable OS temp listing never turns the unowned OS parent into a storage item.
        const legacy = (await entries(tempParent, () => denied(markedRoot))).filter(path => basename(path).startsWith('happier-') && path !== markedRoot);
        const candidates = [...await entries(markedRoot, denied), ...legacy];
        const scratchRoots = [...(context.deps.installDir ? [join(context.deps.installDir, '.tmp')] : []),
            ...(await directoriesAtDepth(join(context.deps.happyHomeDir, 'tools'), 1, denied)).map(tool => join(tool, '.tmp'))];
        for (const scratchRoot of [...new Set(scratchRoots)]) {
            candidates.push(...await entries(getHappierTempRoot(scratchRoot), denied),
                ...(await entries(scratchRoot, denied)).filter(path => path !== getHappierTempRoot(scratchRoot)));
        }
        for (const path of [...new Set(candidates)]) {
            if (path.endsWith('.owner.json')) continue;
            const stat = await listedEntryStat(path, denied);
            if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
            result.push(item('temporary', path, await temporaryCanGo(path, context, legacy.includes(path)),
                { title: opaqueItemTitle(path, 'Happier temporary files'), evidence: ['happier_temporary_directory'] }));
        }
        const facts = new Map(context.temporaryFacts.map(fact => [fact.path, fact.state]));
        for (const root of scopedRoots(context)) {
            let paths = await entries(root, denied);
            if (basename(root) === 'composer-media-stages') paths = (await Promise.all(paths.map(path => directoriesAtDepth(path, 1, denied)))).flat();
            if (basename(root) === 'scm') paths = (await Promise.all(paths.map(path => entries(path, denied)))).flat();
            for (const path of paths) {
                const state = facts.get(path);
                result.push(item('temporary', path, state === 'in_use' || isInUse(path, context) ? inUse
                    : state === 'closed' || state === 'delivered' || state === 'ended' ? { ...safe, reason: { code: 'stopped' } } : check,
                    { title: opaqueItemTitle(path, basename(root) === 'composer-media-stages' ? 'Composer attachments'
                        : basename(root) === 'scm' ? 'Source control temporary files' : 'Session handoff files'),
                        evidence: [state ? 'temporary_lifecycle_owner' : 'temporary_lifecycle_facts_unavailable'] }));
            }
        }
        return result;
    },
};
