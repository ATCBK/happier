import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { logger } from '@/ui/logger';

import { darwinKeepAwakeInvocation } from './darwin';
import { linuxKeepAwakeInvocation, LINUX_KEEP_AWAKE_READY } from './linux';
import { windowsKeepAwakeInvocation } from './windows';

export type KeepAwakeMode = 'off' | 'on' | 'on_power';
export type KeepAwakeState = Readonly<{
    holding: boolean;
    unavailableReason?: 'no_inhibitor' | 'helper_missing';
}>;
export interface KeepAwake {
    read(): KeepAwakeState;
    update(mode?: KeepAwakeMode, onAC?: boolean | null): Promise<void>;
    release(): Promise<void>;
    subscribe(listener: (state: KeepAwakeState) => void): () => void;
}

/** One holder, owned by the machine daemon. Session activity never adds holders. */
export function createKeepAwake(input: Readonly<{
    platform?: NodeJS.Platform;
    daemonPid?: number;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    exists?: (path: string) => boolean;
    resolveExecutable?: (platform: NodeJS.Platform) => string | null;
}> = {}): KeepAwake {
    const platform = input.platform ?? process.platform;
    const spawnProcess = input.spawn ?? spawn;
    const invocationFor = (mode: KeepAwakeMode) => platform === 'darwin'
        ? darwinKeepAwakeInvocation(mode === 'on_power' ? 'on_power' : 'on', input.daemonPid ?? process.pid)
        : platform === 'linux' ? linuxKeepAwakeInvocation(input.exists)
        : platform === 'win32' ? windowsKeepAwakeInvocation(input.resolveExecutable) : null;
    const missingReason = platform === 'win32' ? 'helper_missing' : 'no_inhibitor';
    const listeners = new Set<(state: KeepAwakeState) => void>();
    // Presence is observable without starting an inhibitor, including while Off.
    // It cannot erase a later native acquisition failure; only readiness can.
    let state: KeepAwakeState = invocationFor('off') ? { holding: false } : { holding: false, unavailableReason: missingReason };
    let desiredMode: KeepAwakeMode = 'off';
    let desiredAC: boolean | null = null;
    let holder: { child: ChildProcess; mode: KeepAwakeMode; closed: Promise<void>; ready: boolean } | null = null;
    let reconciliation = Promise.resolve();
    let lastFailure: string | null = null;
    const publish = (next: KeepAwakeState) => {
        if (state.holding === next.holding && state.unavailableReason === next.unavailableReason) return;
        state = next;
        for (const listener of listeners) listener(state);
    };
    const failure = (message: string) => {
        if (message !== lastFailure) logger.warn('[keep awake] Inhibitor unavailable', message);
        else logger.debug('[keep awake] Inhibitor unavailable', message);
        lastFailure = message;
    };
    const retire = async () => {
        const previous = holder;
        if (!previous) return;
        // Publish release before waiting. A successor is never launched until
        // this process has actually closed, avoiding two simultaneous holders.
        publish({ ...state, holding: false });
        if (platform === 'darwin') previous.child.kill('SIGTERM');
        else previous.child.stdin?.end();
        await previous.closed;
        if (holder === previous) holder = null;
    };
    const reconcile = async () => {
        for (;;) {
            const mode = desiredMode;
            const wantsHold = mode === 'on' || mode === 'on_power' && (platform === 'darwin' || desiredAC === true);
            if (holder && (!wantsHold || holder.mode !== mode)) {
                await retire();
                continue;
            }
            if (desiredMode !== mode) continue;
            if (holder) {
                publish({ ...state, holding: holder.ready && (mode === 'on' || desiredAC === true) });
                return;
            }
            const invocation = invocationFor(mode);
            if (!invocation) {
                publish({ holding: false, unavailableReason: missingReason });
                return;
            }
            if (!wantsHold) return;
            try {
                publish({ ...state, holding: false });
                const child = spawnProcess(invocation.command, invocation.args, {
                    stdio: platform === 'darwin' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
                    detached: false, windowsHide: true,
                });
                let close!: () => void;
                const closed = new Promise<void>(resolve => { close = resolve; });
                const current = { child, mode, closed, ready: false };
                holder = current;
                const clear = () => {
                    close();
                    if (holder !== current) return;
                    holder = null;
                    publish(!current.ready && desiredMode !== 'off'
                        ? { holding: false, unavailableReason: 'no_inhibitor' } : { ...state, holding: false });
                };
                child.once('close', clear);
                child.once('error', error => {
                    failure(error.message);
                    if (holder === current) publish({ ...state, holding: false });
                });
                child.once('exit', (code, signal) => {
                    if (holder === current && state.holding && desiredMode !== 'off') failure(`inhibitor exited (${code ?? signal})`);
                    if (holder === current) publish({ ...state, holding: false });
                });
                const ready = () => {
                    if (holder === current && child.exitCode === null && child.signalCode === null && desiredMode === mode) {
                        current.ready = true;
                        publish({ holding: mode === 'on' || desiredAC === true });
                    }
                };
                if (platform === 'darwin') child.once('spawn', ready);
                else {
                    // cat echoes only after systemd-inhibit acquired its lock;
                    // Windows emits readiness after the native power call succeeds.
                    let output = '';
                    child.stdout?.setEncoding('utf8');
                    child.stdout?.on('data', (chunk: string) => {
                        output += chunk;
                        const newline = output.indexOf('\n');
                        if (newline < 0) return;
                        const line = output.slice(0, newline);
                        output = '';
                        if (platform === 'linux' && `${line}\n` === LINUX_KEEP_AWAKE_READY
                            || platform === 'win32' && line === '{"holding":true,"v":1}') ready();
                    });
                    child.stderr?.setEncoding('utf8');
                    child.stderr?.on('data', (chunk: string) => failure(chunk.trim()));
                    child.stdin?.on('error', error => { failure(error.message); child.kill('SIGTERM'); });
                    if (platform === 'linux') child.stdin?.write(LINUX_KEEP_AWAKE_READY);
                }
            } catch (error) {
                failure(error instanceof Error ? error.message : String(error));
                publish({ holding: false });
            }
            return;
        }
    };
    const update = (mode: KeepAwakeMode = 'on', onAC: boolean | null = null): Promise<void> => {
        desiredMode = mode;
        desiredAC = onAC;
        reconciliation = reconciliation.then(reconcile);
        return reconciliation;
    };
    return { read: () => state, update, release: () => update('off'),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
