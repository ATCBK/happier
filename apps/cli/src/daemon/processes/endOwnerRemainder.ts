import { resolveProcessOwnership } from './ownership/resolveProcessOwnership';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot, type ProcessOwnerRef, type ResolvedProcessOwnership } from './ownership/types';
import type { createProcessOwnershipRuntime } from './ownership/processOwnershipRuntime';
import { captureProcessTree, createProcessTreeTerminator, type ProcessTreeTerminationResult } from '@/processes/terminate/terminateProcessTree';
import type { ProcessCensusSnapshot, ProcessStartIdentity } from '@/processes/census/processCensus';
import { logger } from '@/ui/logger';
import { descendantsOf, indexCensus, membersOfCgroup, membersOfJob } from '@/processes/tree/processTree';

export type OwnerRemainderCapture = Readonly<{
    roots: readonly HappierProcessRoot[];
    ownership: readonly ResolvedProcessOwnership[];
    scope?: 'owner' | 'subtree';
}>;
export type OwnerRemainderResult = Readonly<{
    status: 'complete' | 'incomplete' | 'unavailable';
    outcomes: ProcessTreeTerminationResult['outcomes'];
}>;
export type OwnerRemainderPort = Readonly<{
    capture(owner: ProcessOwnerRef): Promise<OwnerRemainderCapture | undefined>;
    captureTree(owner: ProcessOwnerRef, root: Readonly<{ pid: number; start?: ProcessStartIdentity }>): Promise<OwnerRemainderCapture | undefined>;
    end(owner: ProcessOwnerRef, captured?: OwnerRemainderCapture): Promise<OwnerRemainderResult>;
    /** Terminal close leaves nohup survivors alive, retaining evidence for LeftBehind. */
    observeEnd(owner: ProcessOwnerRef, captured?: OwnerRemainderCapture): Promise<OwnerRemainderResult>;
}>;

/** The daemon lifecycle consumes its existing census/root owner; this keeps no registry or sampler. */
export function createEndOwnerRemainder(input: Readonly<{
    processOwnershipRuntime: ReturnType<typeof createProcessOwnershipRuntime>;
    daemonScopeKey: string;
    platform?: NodeJS.Platform;
    firstPass(owner: ProcessOwnerRef): void | Promise<void>;
    retainEndedRoots?(roots: readonly HappierProcessRoot[]): void;
    /** OS boundary used by the canonical terminator, not a replacement ownership/signal path. */
    systemBoundary?: Parameters<typeof createProcessTreeTerminator>[0];
}>): OwnerRemainderPort {
    const terminate = createProcessTreeTerminator(input.systemBoundary);
    const reportUnavailable = () => logger.infoFile('[process-remainder] Native owner observation unavailable',
        { code: 'process_owner_observation_unavailable' });
    function endedRoots(current: readonly HappierProcessRoot[], key: string, captured?: OwnerRemainderCapture) {
        const roots = [...current];
        for (const root of captured?.roots ?? []) {
            if (!roots.some(candidate => candidate.pid === root.pid && equalProcessStart(candidate.start, root.start)
                && processOwnerKey(candidate.owner) === key)) roots.push(root);
        }
        const endedAtMs = Date.now();
        const ended = roots.filter(root => processOwnerKey(root.owner) === key)
            .map(root => ({ ...root, live: false, endedAtMs: root.endedAtMs ?? endedAtMs }));
        input.retainEndedRoots?.(ended);
        return { roots, ended };
    }
    async function firstPass(owner: ProcessOwnerRef) {
        await Promise.resolve().then(() => input.firstPass(owner)).catch(() => {
            logger.infoFile('[process-remainder] Left-behind observation unavailable', { code: 'left_behind_observation_unavailable' });
        });
    }
    function liveCapturedTreePids(owner: ProcessOwnerRef, roots: readonly HappierProcessRoot[], snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>,
        targets: readonly Readonly<{ pid: number; start: ProcessStartIdentity }>[]) {
        const index = indexCensus(snapshot.rows);
        const live = roots.filter(root => {
            // A wrapper's reported worker and its Session-owned Runs share the
            // retiring lifetime. Only a different lifecycle protects a subtree.
            if (processOwnerKey(root.owner) === processOwnerKey(owner)
                || owner.kind === 'session' && root.owner.kind === 'run' && root.owner.sessionId === owner.sessionId) return false;
            const row = index.byPid.get(root.pid);
            return root.live && row && row.state !== 'zombie' && equalProcessStart(row.start, root.start)
                && targets.some(target => target.pid === root.pid && equalProcessStart(target.start, root.start));
        });
        return new Set([...live.map(root => root.pid), ...descendantsOf(index, live.map(root => root.pid)).map(row => row.pid)]);
    }
    return {
        async capture(owner) {
            const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            if (view.status !== 'ok') { reportUnavailable(); return undefined; }
            const key = processOwnerKey(owner);
            return { roots: view.roots.filter(root => processOwnerKey(root.owner) === key),
                ownership: view.rows.filter(row => row.owner && processOwnerKey(row.owner) === key) };
        },
        async captureTree(owner, root) {
            const capture = await captureProcessTree(root);
            if (capture.status !== 'ok') { reportUnavailable(); return undefined; }
            const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            if (view.status !== 'ok') { reportUnavailable(); return undefined; }
            // Aliases of the retiring owner are one lifetime. Independently tracked
            // descendant roots and their subtrees keep their own lifecycle.
            const independent = liveCapturedTreePids(owner, view.roots, view.snapshot,
                capture.capturedTargets.filter(target => target.pid !== root.pid));
            return { scope: 'subtree', ownership: [], roots: capture.capturedTargets.filter(target => !independent.has(target.pid)).map(target => ({
                owner, ...target, live: true, ownerCreatedAtMs: capture.capturedAtMs,
                ownerCreatedStartTimeMs: target.start.startTimeMs,
            })) };
        },
        async observeEnd(owner, captured) {
            try {
                const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                if (view.status !== 'ok') reportUnavailable();
                const key = processOwnerKey(owner);
                if (captured?.scope === 'subtree') {
                    // These exact native generations ended with their own spawner;
                    // the shared daemon owner and its unrelated peers remain live.
                    endedRoots([], key, captured);
                    return { status: view.status === 'ok' ? 'complete' : 'unavailable', outcomes: [] };
                }
                if (view.status === 'ok' && view.roots.some(root => root.live && processOwnerKey(root.owner) === key
                    && view.snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)))) {
                    return { status: 'complete', outcomes: [] };
                }
                endedRoots(view.status === 'ok' ? view.roots : [], key, captured);
                return { status: view.status === 'ok' ? 'complete' : 'unavailable', outcomes: [] };
            } finally { await firstPass(owner); }
        },
        async end(owner, captured) {
            try {
                const view = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                if (view.status !== 'ok') { reportUnavailable(); return { status: 'unavailable', outcomes: [] }; }
                const key = processOwnerKey(owner);
                if (captured?.scope === 'subtree') {
                    const live = liveCapturedTreePids(owner, view.roots, view.snapshot, captured.roots);
                    const targets = captured.roots.filter(target => !live.has(target.pid));
                    // An exact pre-exit tree is physical custody, including
                    // Run-tagged descendants. Logical owner projection cannot
                    // erase it after reparenting, or transfer it to a new PID.
                    endedRoots([], key, { ...captured, roots: targets });
                    const results: ProcessTreeTerminationResult[] = [];
                    // A reowned member protects only its own tree, never the
                    // other captured targets. Preserve descendants-first order.
                    for (const target of [...targets].reverse()) {
                        const observed = view.snapshot.rows.find(row => row.pid === target.pid);
                        if ((!observed && !view.snapshot.partial?.some(row => row.pid === target.pid))
                            || observed?.state === 'zombie' && equalProcessStart(observed.start, target.start)) {
                            // This fresh census already proves the captured generation
                            // departed. Re-reading the entire machine for each dead
                            // child delays both Stop and the waiting replacement.
                            results.push({ status: 'complete', outcomes: [{ pid: target.pid, outcome: 'gone_before' }] });
                            continue;
                        }
                        results.push(await terminate({ targets: [{ pid: target.pid, start: target.start }], tree: false,
                            async authorizeSignal() {
                                const current = await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
                                return current.status === 'ok' && !liveCapturedTreePids(owner, current.roots, current.snapshot, captured.roots).has(target.pid);
                            },
                            async authorizeSnapshot(snapshot) {
                                const current = await input.processOwnershipRuntime.resolveSnapshot(snapshot, undefined, { requesterAttribution: 'retained' });
                                return current.status === 'ok' && !liveCapturedTreePids(owner, current.roots, snapshot, captured.roots).has(target.pid);
                            },
                        }));
                    }
                    return { status: results.some(result => result.status === 'unavailable') ? 'unavailable'
                        : results.some(result => result.status === 'incomplete') ? 'incomplete' : 'complete',
                        outcomes: results.flatMap(result => result.outcomes) };
                }
                // A resumed owner reowns its tagged processes. An older exit cannot retire it.
                const liveOwner = view.roots.some(root => root.live && processOwnerKey(root.owner) === key
                    && view.snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)));
                if (liveOwner) return { status: 'complete', outcomes: [] };
                const { roots, ended } = endedRoots(view.roots, key, captured);
                const ownership = resolveProcessOwnership({ snapshot: view.snapshot,
                    roots: [...roots.filter(root => processOwnerKey(root.owner) !== key), ...ended],
                    daemonPrincipal: view.snapshot.rows.find(row => row.pid === process.pid)?.principal ?? null,
                    daemonScopeKey: input.daemonScopeKey, platform: input.platform,
                    capturedOwnership: captured?.ownership });
                const ownedRows = ownership.filter(row => row.owner && processOwnerKey(row.owner) === key);
                // Group/port-only evidence is a hint for the daemon's two-pass tracker, never kill authority.
                const targets = ownedRows.filter(row => row.level !== 'unknown' && row.evidence.some(evidence =>
                    evidence.state === 'met' && ['fence', 'parent_chain', 'marker'].includes(evidence.kind)));
                const containment = ended.length === 1 ? ended[0]?.containment : undefined;
                const censusIndex = indexCensus(view.snapshot.rows);
                const members = containment?.kind === 'linux_unit' ? membersOfCgroup(censusIndex, containment.prefix)
                    : containment?.kind === 'windows_job' ? membersOfJob(censusIndex, containment.name) : [];
                // Preserve whole-fence cleanup only when every fresh member belongs to this owner;
                // a swapped live owner in an old physical fence is an exact-identity sweep instead.
                const exclusiveContainment = containment && members.every(member => targets.some(target =>
                    target.pid === member.pid && equalProcessStart(target.start, member.start))) ? containment : undefined;
                const result = await terminate({ targets: targets.map(row => ({ pid: row.pid, start: row.start })), tree: false,
                    ...(exclusiveContainment ? { containment: exclusiveContainment } : {}),
                        async authorizeSnapshot(snapshot) {
                            const current = await input.processOwnershipRuntime.resolveSnapshot(snapshot, undefined, { requesterAttribution: 'retained' });
                            if (current.status !== 'ok') return false;
                            if (current.roots.some(root => root.live && processOwnerKey(root.owner) === key
                                && snapshot.rows.some(row => row.pid === root.pid && row.state !== 'zombie' && equalProcessStart(row.start, root.start)))) return false;
                            // Current live/resumed roots retain precedence over captured ended facts.
                            const known = [...current.roots];
                            for (const root of ended) if (!known.some(value => value.pid === root.pid
                                && equalProcessStart(value.start, root.start) && processOwnerKey(value.owner) === key)) known.push(root);
                            const ownership = resolveProcessOwnership({ snapshot, roots: known,
                                daemonPrincipal: snapshot.rows.find(row => row.pid === process.pid)?.principal ?? null,
                                daemonScopeKey: input.daemonScopeKey, platform: input.platform, capturedOwnership: captured?.ownership });
                            const index = indexCensus(snapshot.rows);
                            const freshMembers = exclusiveContainment?.kind === 'linux_unit' ? membersOfCgroup(index, exclusiveContainment.prefix)
                                : exclusiveContainment?.kind === 'windows_job' ? membersOfJob(index, exclusiveContainment.name)
                                : snapshot.rows.filter(row => targets.some(target => row.pid === target.pid && equalProcessStart(row.start, target.start)));
                            // Positive zombie state already proves exit; ownership
                            // enrichment may disappear before the kernel reaps it.
                            return freshMembers.every(member => member.state === 'zombie' || ownership.some(row => row.pid === member.pid
                                && equalProcessStart(row.start, member.start) && row.ownerEnded && row.owner
                                && processOwnerKey(row.owner) === key && row.level !== 'unknown'
                                && row.evidence.some(evidence => evidence.state === 'met' && ['fence', 'parent_chain', 'marker'].includes(evidence.kind))));
                        },
                    });
                const incomplete = ownedRows.length > targets.length || result.outcomes.some(row => row.outcome === 'refused' || row.outcome === 'survived');
                return { status: result.status === 'unavailable' ? 'unavailable' : incomplete || result.status === 'incomplete' ? 'incomplete' : 'complete', outcomes: result.outcomes };
            } finally {
                await firstPass(owner);
            }
        },
    };
}
