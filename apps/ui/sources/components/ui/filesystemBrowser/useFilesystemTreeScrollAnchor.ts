import type * as React from 'react';

type PathNode = Readonly<{ path: string }>;

/** Preserve the tree's reading row by identity when directory results change its position. */
export function useFilesystemTreeScrollAnchor<Node extends PathNode>(_input: Readonly<{
    nodes: readonly Node[];
    scopeKey: string;
    listRef: React.RefObject<Readonly<{ scrollToIndex(input: { index: number; animated: boolean; viewPosition: number }): unknown }> | null>;
}>): (nodes: readonly Node[]) => void {
    return () => {};
}
