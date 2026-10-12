import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';

/** Installer commands share the daemon's existing process-tree cancellation owner. */
export const executeInstallCommand: typeof execFileWithDeadline = (command, args, options = {}) =>
    execFileWithDeadline(command, args, {
        ...options,
        terminateOnAbort: (child) => terminateProcessTree(child),
    });
