import type { SystemTaskRunner } from '@/components/systemTasks/types';

/** The native runner has no SSH-agent transport; UI and Action admission consume this capability fact. */
export function getMachineAddSshSupportedAuthModes(runner: SystemTaskRunner) {
    return runner.mode === 'native' ? ['keyfile', 'password'] as const : ['agent', 'keyfile', 'password'] as const;
}
