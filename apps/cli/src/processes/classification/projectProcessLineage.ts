import { ancestorsOf, indexCensus } from '@/processes/tree/processTree';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import { redactProcessCommand } from '@/processes/redaction/redactProcessCommand';

export type ProcessCommandFact = Readonly<{
    pid: number; ppid?: number; processStartTimeMs?: number; command: string; cwd?: string;
    censusRow?: ProcessCensusRow;
}>;
function commandScore(command: string): number {
    if (/(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)/iu.test(command)) return 100;
    if (/\b(?:vite|next|nuxt|astro|expo|webpack-dev-server|uvicorn|flask|django|rails|cargo|dotnet)\b/iu.test(command)) return 80;
    if (/(?:^|\s)(?:node|python|python3|tsx|ts-node|vite|next|nuxt|astro)(?:\s|$|\.|\/)/iu.test(command)) return 60;
    return 50;
}
export function processFactToCensusRow(fact: ProcessCommandFact): ProcessCensusRow {
    return fact.censusRow ?? { pid: fact.pid, ppid: fact.ppid ?? null,
        start: { startTimeMs: fact.processStartTimeMs ?? 0 }, principal: null, name: fact.command.split(/\s/u)[0] ?? '',
        commandLine: fact.command, cwd: fact.cwd, memory: null, cpuTimeUs: null };
}

/** One current scan's label projection shares its census index; it never decides ownership. */
export function createProcessLineageProjector(processes: ReadonlyMap<number, ProcessCommandFact>) {
    const index = indexCensus([...processes.values()].map(processFactToCensusRow));
    return (listenerPid: number) => {
        const lineage = [index.byPid.get(listenerPid), ...ancestorsOf(index, listenerPid)].filter((item): item is ProcessCensusRow => item !== undefined);
        const facts = lineage.flatMap(item => { const fact = processes.get(item.pid); return fact ? [fact] : []; });
        const listener = processes.get(listenerPid);
        let best = listener;
        for (const fact of facts) if (!best || commandScore(fact.command) > commandScore(best.command)) best = fact;
        return { pid: listenerPid, ...(listener?.ppid ? { ppid: listener.ppid } : {}),
            ...(listener?.processStartTimeMs !== undefined ? { processStartTimeMs: listener.processStartTimeMs } : {}),
            lineagePids: facts.length ? facts.map(item => item.pid) : [listenerPid],
            command: redactProcessCommand(best?.censusRow?.argv ?? best?.command ?? 'unknown').trim() || 'unknown',
            ...(best?.cwd ? { cwd: best.cwd } : {}), redacted: true as const };
    };
}
