import * as React from 'react';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

type DiffLineSlot = ((line: CodeLine) => React.ReactNode) | undefined;

/** One annotation preserves each owner in order, including caller comments and folds. */
export function composeDiffLineSlots(...slots: readonly DiffLineSlot[]): (line: CodeLine) => React.ReactNode {
    return (line) => {
        const nodes = slots.map((slot) => slot?.(line)).filter((node) => node !== null && node !== undefined && typeof node !== 'boolean');
        if (nodes.length === 0) return null;
        if (nodes.length === 1) return nodes[0];
        return <>{nodes.map((node, index) => <React.Fragment key={index}>{node}</React.Fragment>)}</>;
    };
}
