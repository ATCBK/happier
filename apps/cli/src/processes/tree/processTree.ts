import type { ProcessCensusRow } from '../census/processCensus';

export type ProcessCensusIndex = Readonly<{
    byPid: ReadonlyMap<number, ProcessCensusRow>;
    childrenOf: ReadonlyMap<number, readonly ProcessCensusRow[]>;
}>;

export function indexCensus(rows: readonly ProcessCensusRow[]): ProcessCensusIndex {
    const byPid = new Map<number, ProcessCensusRow>();
    const childrenOf = new Map<number, ProcessCensusRow[]>();
    for (const row of rows) byPid.set(row.pid, row);
    for (const row of byPid.values()) {
        if (row.ppid === null) continue;
        const children = childrenOf.get(row.ppid) ?? [];
        children.push(row);
        childrenOf.set(row.ppid, children);
    }
    return { byPid, childrenOf };
}

export function descendantsOf(index: ProcessCensusIndex, roots: readonly number[]): readonly ProcessCensusRow[] {
    const seen = new Set(roots);
    const queue = [...roots];
    const descendants: ProcessCensusRow[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
        for (const child of index.childrenOf.get(queue[cursor]!) ?? []) {
            if (child.pid <= 1 || seen.has(child.pid)) continue;
            seen.add(child.pid);
            queue.push(child.pid);
            descendants.push(child);
        }
    }
    return descendants;
}

/** Nearest parent first. Missing links and cycles stop a walk; there is no arbitrary depth limit. */
export function ancestorsOf(index: ProcessCensusIndex, pid: number): readonly ProcessCensusRow[] {
    const seen = new Set([pid]);
    const ancestors: ProcessCensusRow[] = [];
    let parent = index.byPid.get(pid)?.ppid;
    while (parent !== null && parent !== undefined && parent > 1 && !seen.has(parent)) {
        const row = index.byPid.get(parent);
        if (!row) break;
        seen.add(parent);
        ancestors.push(row);
        parent = row.ppid;
    }
    return ancestors;
}

export function membersOfCgroup(index: ProcessCensusIndex, path: string): readonly ProcessCensusRow[] {
    const base = path.replace(/\/+$/u, '') || '/';
    return [...index.byPid.values()].filter(row => row.cgroup === base || row.cgroup?.startsWith(base === '/' ? '/' : `${base}/`));
}
export function membersOfJob(index: ProcessCensusIndex, name: string): readonly ProcessCensusRow[] {
    return [...index.byPid.values()].filter(row => row.jobs?.includes(name));
}
export function membersOfPgid(index: ProcessCensusIndex, pgid: number): readonly ProcessCensusRow[] {
    return [...index.byPid.values()].filter(row => row.pgid === pgid);
}
export function protectedSet(index: ProcessCensusIndex, selfPid: number, input: Readonly<{ signalExtent?: 'process' | 'group' }> = {}): ReadonlySet<number> {
    const protectedPids = new Set([0, 1, selfPid]);
    const lineage = [index.byPid.get(selfPid), ...ancestorsOf(index, selfPid)];
    for (const ancestor of lineage) if (ancestor) protectedPids.add(ancestor.pid);
    if (input.signalExtent === 'process') return protectedPids;
    const protectedGroups = new Set(lineage.flatMap(row => row?.pgid === undefined ? [] : [row.pgid]));
    for (const row of index.byPid.values()) {
        if (row.pid <= 1 || (row.pgid !== undefined && protectedGroups.has(row.pgid))) protectedPids.add(row.pid);
    }
    return protectedPids;
}
