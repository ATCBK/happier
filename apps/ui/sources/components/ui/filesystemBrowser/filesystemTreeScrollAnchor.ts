export function resolveFilesystemTreeScrollAnchorIndex(input: Readonly<{
    previousNodes: readonly Readonly<{ path: string }>[];
    nodes: readonly Readonly<{ path: string }>[];
    anchorPath: string | null;
    previousScopeKey: string;
    scopeKey: string;
}>): number | null {
    if (input.previousScopeKey !== input.scopeKey || input.anchorPath === null) return null;
    const previousIndex = input.previousNodes.findIndex(node => node.path === input.anchorPath);
    const index = input.nodes.findIndex(node => node.path === input.anchorPath);
    return previousIndex >= 0 && index >= 0 && previousIndex !== index ? index : null;
}
