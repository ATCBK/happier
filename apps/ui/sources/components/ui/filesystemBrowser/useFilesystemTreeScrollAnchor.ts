import * as React from 'react';
import { resolveFilesystemTreeScrollAnchorIndex } from './filesystemTreeScrollAnchor';

type PathNode = Readonly<{ path: string }>;

/** Preserve the tree's reading row by identity when directory results change its position. */
export function useFilesystemTreeScrollAnchor<Node extends PathNode>(input: Readonly<{
    nodes: readonly Node[];
    scopeKey: string;
    listRef: React.RefObject<Readonly<{ scrollToIndex(input: { index: number; animated: boolean; viewPosition: number }): unknown }> | null>;
}>): (nodes: readonly Node[]) => void {
    const previous = React.useRef({ nodes: input.nodes, scopeKey: input.scopeKey });
    const anchorPath = React.useRef<string | null>(null);
    const scope = React.useRef(input.scopeKey);
    scope.current = input.scopeKey;
    React.useLayoutEffect(() => {
        const index = resolveFilesystemTreeScrollAnchorIndex({ ...input, previousNodes: previous.current.nodes,
            previousScopeKey: previous.current.scopeKey, anchorPath: anchorPath.current });
        if (previous.current.scopeKey !== input.scopeKey) anchorPath.current = null;
        previous.current = { nodes: input.nodes, scopeKey: input.scopeKey };
        if (index !== null) void input.listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    }, [input.listRef, input.nodes, input.scopeKey]);
    return React.useCallback(nodes => {
        if (scope.current === input.scopeKey) anchorPath.current = nodes[0]?.path ?? null;
    }, [input.scopeKey]);
}
