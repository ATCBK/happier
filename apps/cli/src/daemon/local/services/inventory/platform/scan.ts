import { readFile, readdir, readlink } from 'node:fs/promises';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import type {
    LocalServiceInventoryDiagnostic,
    LocalServiceListenerFact,
} from '../scanner';
import type {
    LocalServiceProcessFact,
    LocalServiceWorkspaceFact,
} from '../provenance';
import { readDarwinLocalServiceListeners } from './darwin';
import { readLinuxLocalServiceListeners } from './linux';
import { readWindowsLocalServiceListeners } from './windows';

export type LocalServicesScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    /** The same socket observation's optional detail phase, owned by its refresh flight. */
    readProcessFacts?: () => Promise<ReadonlyMap<number, LocalServiceProcessFact>>;
    workspaces: readonly LocalServiceWorkspaceFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
    /** Private OS coverage facts consumed by the canonical ownership normalizer. */
    socketOwnerReadFailures?: readonly number[];
    /** Linux count-only scans attribute only the supplied internal PIDs. */
    listenerOwnersRestricted?: true;
}>;

/**
 * The single platform boundary used by inventory and managed endpoint detection.
 *
 * darwin (`lsof`) and windows (`netstat`) socket probes run through `execFileWithDeadline`
 * rather than a `child_process` `timeout`, which reports a killed scan as a SUCCESS with empty
 * stdout on a stalled loop — indistinguishable from "nothing is listening". Linux reads `/proc`
 * and spawns nothing, so it has never been exposed to it.
 */
export async function scanPlatformLocalServices(options: Readonly<{
    includeProcessFacts?: boolean;
    listenerOwnerPids?: readonly number[];
}> = {}): Promise<LocalServicesScanResult> {
    if (process.platform === 'darwin') {
        const result = await readDarwinLocalServiceListeners({
            execFile: execFileWithDeadline,
            ...options,
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            ...(result.readProcessFacts ? { readProcessFacts: result.readProcessFacts } : {}),
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    if (process.platform === 'win32') {
        const result = await readWindowsLocalServiceListeners({
            execFile: execFileWithDeadline,
            ...options,
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            ...(result.readProcessFacts ? { readProcessFacts: result.readProcessFacts } : {}),
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    const result = await readLinuxLocalServiceListeners({
        readFile,
        readdir,
        readlink,
        ...options,
    });
    return {
        listeners: result.listeners,
        processes: result.processes,
        ...(result.readProcessFacts ? { readProcessFacts: result.readProcessFacts } : {}),
        workspaces: [],
        diagnostics: result.diagnostics,
        socketOwnerReadFailures: result.socketOwnerReadFailures,
        ...(result.listenerOwnersRestricted ? { listenerOwnersRestricted: true } : {}),
    };
}
