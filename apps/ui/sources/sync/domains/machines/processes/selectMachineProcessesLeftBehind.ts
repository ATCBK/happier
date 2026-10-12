import type { LeftBehindRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

/** The rendered set and the echoed cleanup refs are one projection, including search and review narrowing. */
export function selectMachineProcessesLeftBehind(rows: readonly LeftBehindRowV1[], filter: Readonly<{
    query?: string; role?: LeftBehindRowV1['role']; selectedRefs?: ReadonlySet<string>;
}> = {}) {
    const query = filter.query?.trim().toLocaleLowerCase();
    const seen = new Set<string>();
    const items = rows.filter(row => {
        if (seen.has(row.ref) || (filter.role && filter.role !== row.role) || (filter.selectedRefs && !filter.selectedRefs.has(row.ref))) return false;
        if (query && ![row.name, row.command, row.role, String(row.pid), ...(row.ports?.map(port => String(port.port)) ?? [])]
            .some(value => value?.toLocaleLowerCase().includes(query))) return false;
        seen.add(row.ref); return true;
    });
    return { items, refs: items.map(row => row.ref), count: items.length,
        memoryBytes: items.some(row => row.memoryBytes === null) ? null : items.reduce((sum, row) => sum + (row.memoryBytes ?? 0), 0) };
}
