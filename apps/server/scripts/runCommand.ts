import { spawn } from 'node:child_process';
import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';

type CommandInvocation = Readonly<{
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
}>;

type ResolveCommandOptions = Readonly<{
    platform?: NodeJS.Platform;
    processExecPath?: string;
    comspec?: string | null;
}>;

type RunCommandOptions = Readonly<{
    cwd?: string;
}>;

export function resolveServerScriptCommandInvocation(
    cmd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    options: ResolveCommandOptions = {},
): CommandInvocation {
    const normalized = cmd.trim().toLowerCase();
    if (normalized === 'pnpm' || normalized === 'pnpm.cmd') {
        return resolvePnpmCommandInvocation([...args], {
            ...options,
            npmExecPath: String(env.npm_execpath ?? ''),
            comspec: options.comspec ?? env.COMSPEC ?? env.ComSpec ?? env.comspec,
        });
    }
    return { command: cmd, args: [...args] };
}

export function runCommand(
    cmd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    options: RunCommandOptions = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        const invocation = resolveServerScriptCommandInvocation(cmd, args, env);
        const child = spawn(invocation.command, invocation.args, {
            cwd: options.cwd,
            env,
            stdio: 'inherit',
            shell: false,
            ...(invocation.windowsVerbatimArguments
                ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
                : {}),
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}
