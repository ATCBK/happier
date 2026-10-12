import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

export function windowsKeepAwakeInvocation(resolveExecutable: (platform: NodeJS.Platform) => string | null = resolveProcessCustodySupportExecutable) {
    const command = resolveExecutable('win32');
    return command ? { command, args: ['keep-awake'] } : null;
}
