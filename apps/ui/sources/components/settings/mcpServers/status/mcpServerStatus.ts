import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

/**
 * A server's sign-in as the status owner reads it (T2 states, U7.9's `useMcpServerSignIn`). `null`: the
 * server does not sign in (no OAuth), so sign-in never speaks.
 */
export type McpServerSignInFact =
    | Readonly<{ state: 'not_connected' | 'did_not_finish' | 'no_machine_online' | 'client_refused' }>
    | Readonly<{ state: 'signing' }>
    | Readonly<{ state: 'connected' }>
    | Readonly<{ state: 'needs_more_access' }>
    | Readonly<{ state: 'expired'; reason: 'expired' | 'address_changed'; at?: string }>
    | Readonly<{ state: 'revoked' }>
    | null;

/** One machine's latest Test answer, held for the app session (T7). */
export type McpServerTestFact =
    | Readonly<{ ok: true; toolCount: number; checkedAt: number }>
    | Readonly<{ ok: false; errorCode: string; runtimeMissing?: string; checkedAt: number }>;

/** A machine where the server is on (P2 projection), with REACH's presence. */
export type McpServerMachineFact = Readonly<{ machineId: string; name: string; online: boolean; lastSeen?: string }>;

export type McpServerStatusFixes = Readonly<{
    signIn: () => void;
    reconnect: () => void;
    grantAccess: () => void;
    addKey: () => void;
    howToFix: (machineId: string) => void;
    tryAgain: (machineId: string) => void;
}>;

export type McpServerStatusInput = Readonly<{
    entry: McpServerCatalogEntryV1;
    signIn: McpServerSignInFact;
    tests: Readonly<Record<string, McpServerTestFact | undefined>>;
    machines: readonly McpServerMachineFact[];
    /** Saved Secrets this Account holds, by id: a reference to anything else is a missing key. */
    savedSecretIds: ReadonlySet<string>;
    fixes: McpServerStatusFixes;
}>;

function* secretIdsOf(ref: ValueRefV1): Generator<string> {
    if (ref.t === 'savedSecret') yield ref.secretId;
    if (ref.t === 'template') for (const variable of Object.values(ref.vars)) if (variable.t === 'savedSecret') yield variable.secretId;
}

export function mcpServerNeedsKey(entry: McpServerCatalogEntryV1, savedSecretIds: ReadonlySet<string>): boolean {
    return mcpServerMissingKeyNames(entry, savedSecretIds).size > 0;
}

/** The env and header names whose Saved Secret is missing: where the banner's "Add key" lands. */
export function mcpServerMissingKeyNames(entry: McpServerCatalogEntryV1, savedSecretIds: ReadonlySet<string>): ReadonlySet<string> {
    const names = new Set<string>();
    const named = [...Object.entries(entry.env), ...Object.entries(entry.remote?.headers ?? {})];
    for (const [name, ref] of named) for (const secretId of secretIdsOf(ref)) if (!savedSecretIds.has(secretId)) names.add(name);
    return names;
}

/**
 * Every status a server has right now, in P5's vocabulary (T7 mapping). The page's banner and the rail
 * pick the most blocking one through `pickMostBlockingCapabilityStatus`; the machine rows read the
 * per-machine entries (each names its machine). Settings pages pass no session notices.
 */
export function mcpServerStatus(input: McpServerStatusInput): readonly CapabilityStatus[] {
    const statuses: CapabilityStatus[] = [];
    const { fixes } = input;
    const signIn = input.signIn;
    if (signIn) {
        switch (signIn.state) {
            case 'not_connected':
            case 'did_not_finish':
            case 'no_machine_online':
            case 'client_refused':
                statuses.push({ kind: 'signin', fix: { kind: 'sign_in', onPress: fixes.signIn } });
                break;
            case 'signing':
                statuses.push({ kind: 'signing' });
                break;
            case 'connected':
                statuses.push({ kind: 'connected' });
                break;
            case 'needs_more_access':
                statuses.push({ kind: 'more_access', fix: { kind: 'grant_access', onPress: fixes.grantAccess } });
                break;
            case 'expired':
                statuses.push({ kind: 'expired', ...(signIn.at ? { detail: signIn.at } : {}), fix: { kind: 'reconnect', onPress: fixes.reconnect } });
                break;
            case 'revoked':
                statuses.push({ kind: 'revoked', fix: { kind: 'sign_in', onPress: fixes.signIn } });
                break;
        }
    }
    if (mcpServerNeedsKey(input.entry, input.savedSecretIds)) {
        statuses.push({ kind: 'key', fix: { kind: 'add_key', onPress: fixes.addKey } });
    }
    statuses.push(...mcpServerMachineStatuses(input).values());
    return statuses;
}

/** Each machine's own status (offline, can't run, stopped), keyed by machine id; healthy machines are absent. */
export function mcpServerMachineStatuses(input: Pick<McpServerStatusInput, 'tests' | 'machines' | 'fixes'>): ReadonlyMap<string, CapabilityStatus> {
    const result = new Map<string, CapabilityStatus>();
    for (const machine of input.machines) {
        const test = input.tests[machine.machineId];
        if (!machine.online) {
            result.set(machine.machineId, { kind: 'offline', machineName: machine.name, ...(machine.lastSeen ? { detail: machine.lastSeen } : {}) });
            continue;
        }
        if (!test || test.ok) continue;
        result.set(machine.machineId, test.runtimeMissing
            ? { kind: 'cantrun', machineName: machine.name, detail: test.runtimeMissing, fix: { kind: 'how_to_fix', onPress: () => input.fixes.howToFix(machine.machineId) } }
            : { kind: 'error', machineName: machine.name, fix: { kind: 'try_again', onPress: () => input.fixes.tryAgain(machine.machineId) } });
    }
    return result;
}
