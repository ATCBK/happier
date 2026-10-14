import { SessionRunnerRuntimeStatusV2Schema, type SessionRunnerRuntimeStatusV2 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV2';

/** A daemon status response at the Machine RPC boundary. */
export function createSessionRunnerRuntimeStatusFixture(input: Readonly<{
    sessionId: string;
    machineId: string;
    pid?: number;
    processStartTimeMs?: number;
    wrapperPid?: number;
    observedAtMs?: number;
}>): SessionRunnerRuntimeStatusV2 {
    const pid = input.pid ?? 123;
    const processStartTimeMs = input.processStartTimeMs ?? 1000;
    return SessionRunnerRuntimeStatusV2Schema.parse({
        v: 2,
        runnerProcessIdentity: { pid, processStartTimeMs },
        state: {
            v: 1, sessionId: input.sessionId, machineId: input.machineId, daemonId: 'test-daemon', observedAtMs: input.observedAtMs ?? 2000,
            runner: { pid: input.wrapperPid ?? pid, entrypointSource: 'structured_state', startedBy: 'daemon', startingMode: 'remote' },
            daemon: { currentEntrypointSource: 'packaged_runtime' },
            versionState: 'unknown', statusSource: 'daemon_tracking',
            plannedRestart: { supported: false, eligible: false, disabledReason: null },
        },
    });
}
