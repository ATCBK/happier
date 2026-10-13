import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';

/** One argv owner for hook, skill and user plugin roots, including SDK extraArgs. */
export function buildClaudePluginDirArgs(input: Readonly<{
    args?: readonly string[];
    hookPluginDir?: string | null;
    skills?: AgentSessionSkillDelivery;
    pluginDirs?: readonly string[];
}>): string[] {
    const args: string[] = [];
    const roots = new Set<string>();
    const addRoot = (root: string | null | undefined) => {
        if (root && !roots.has(root)) {
            roots.add(root);
            args.push('--plugin-dir', root);
        }
    };
    for (let index = 0; index < (input.args?.length ?? 0); index++) {
        const arg = input.args![index];
        if (arg === '--plugin-dir' && typeof input.args?.[index + 1] === 'string') {
            addRoot(input.args[++index]);
        } else if (arg.startsWith('--plugin-dir=')) {
            addRoot(arg.slice('--plugin-dir='.length));
        } else {
            args.push(arg);
        }
    }
    addRoot(input.hookPluginDir);
    input.pluginDirs?.forEach(addRoot);
    addRoot(input.skills?.pluginRoot);
    return args;
}
