import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm';

import { Modal } from '@/modal';
import { discardChange, type DiscardChangeParams, type DiscardChangeResult } from '@/components/sessions/files/review/discardChange';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { FileMenuContext } from '../fileMenus';
import { resolveFileChangesRestoreIntent } from './fileChangesRestore';

/** Menu behavior only; PAGE supplies the dirty-editor and whole-turn-dialog owners. */
export function useFileChangesActions(input: Omit<DiscardChangeParams, 'entry'> & Readonly<{
    filePath: string;
    selector: SessionScmReviewComparison;
    comparison: ScmComparison | null;
    expectedHash?: string | null;
    /** Selected deletion; the canonical mutation result determines whether Undo exists. */
    deleted?: boolean;
    hasUnsavedEdits: () => boolean;
    onReplacedUnsavedEdits: () => void;
    confirmUnsaved: Readonly<{ title: string; message?: string; confirmText?: string; cancelText?: string }>;
    restoreBeforeTurnTitle?: string;
    /** Offers the existing CheckpointCodeRollbackDialog; never executes rollback itself. */
    offerWholeTurnRollback?: (turnId: string) => void;
}>) {
    const [result, setResult] = React.useState<DiscardChangeResult | null>(null);
    const intent = resolveFileChangesRestoreIntent({ path: input.filePath, selector: input.selector,
        comparison: input.comparison, sessionId: input.sessionTarget?.sessionId, expectedHash: input.expectedHash });
    const restore = async () => {
        const selected = input;
        const entry = intent.entry;
        if (!entry) return;
        const dirty = selected.hasUnsavedEdits();
        if (dirty && !await Modal.confirm(selected.confirmUnsaved.title, selected.confirmUnsaved.message,
            { confirmText: selected.confirmUnsaved.confirmText, cancelText: selected.confirmUnsaved.cancelText, destructive: true })) return;
        const outcome = await discardChange({ target: selected.target, entry, messages: selected.messages,
            readCurrentText: selected.readCurrentText, refresh: selected.refresh, options: selected.options, sessionTarget: selected.sessionTarget });
        setResult(outcome);
        if (outcome.ok) {
            if (dirty) selected.onReplacedUnsavedEdits();
        } else if ((outcome.reason === 'unsupported' || outcome.reason === 'moved_on')
            && selected.selector.kind === 'turnCheckpoint' && selected.selector.turnId) {
            selected.offerWholeTurnRollback?.(selected.selector.turnId);
        }
    };
    const changes: NonNullable<FileMenuContext['changes']> = intent.entry ? {
        discardAll: restore,
        ...(intent.restoreBeforeTurn ? { restoreBeforeTurn: restore,
            ...(input.restoreBeforeTurnTitle ? { restoreBeforeTurnTitle: input.restoreBeforeTurnTitle } : {}) } : {}),
    } : {};
    return { changes, result, restoreDeleted: input.deleted && intent.entry ? restore : undefined };
}
