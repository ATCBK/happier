import { delimiter, isAbsolute, join } from 'node:path';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

/** Shared declared-tool lookup for invocation grants and daemon preflight. */
export function resolveSystemToolLookupCandidates(
    lookupName: string,
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): readonly string[] {
    if (isAbsolute(lookupName)) return [lookupName];
    const candidates: string[] = [];
    // The Windows owner handles PATHEXT and native npm-wrapper targets.
    if (platform === 'win32') {
        const resolved = resolveWindowsCommandOnPath(lookupName, env);
        if (resolved) candidates.push(resolved);
    }
    for (const root of (env.PATH ?? '').split(delimiter).filter(entry => entry.length > 0)) {
        const candidate = join(root, lookupName);
        if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    return candidates;
}
