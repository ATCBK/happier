import * as React from 'react';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

import type { ParticipantComposerDocument } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftDocumentField } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    executionRunLauncherDraftFieldPath,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const SelectionSchema = z.strictObject({
    identity: z.strictObject({ correlationId: z.string().check(z.minLength(1)), inputLocalId: z.string().check(z.minLength(1)) }),
    actionInput: z.record(z.string(), z.unknown()),
});

/** The launcher reads and writes the incumbent Session draft; no separate persistence lifetime. */
export function useExecutionRunLauncherDraft(input: Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
    sessionId: string;
    draftKey: string;
    correlationId?: string;
    createDefaultInput: () => Record<string, unknown>;
}>) {
    const { lifetime, sessionId, draftKey } = input;
    const address = { kind: 'session' as const, sessionId };
    const key = JSON.stringify([lifetime?.scope.serverId ?? null, lifetime?.scope.accountId ?? null, sessionId, draftKey]);
    const selectionPath = executionRunLauncherDraftFieldPath(draftKey, 'selection');
    const selectionFieldId = `extensions.happier.${selectionPath.fieldId}`;
    const readSelectionMutationId = React.useCallback(() => lifetime
        ? getSessionDraftDocumentField(
            getSessionDraftSnapshot(lifetime.scope, { kind: 'session', sessionId })?.document ?? null,
            executionRunLauncherDraftFieldPath(draftKey, 'selection'),
        )?.mutationId ?? null
        : null, [draftKey, lifetime, sessionId]);
    const subscribeSelection = React.useCallback((listener: () => void) => lifetime
        ? subscribeSessionDraft(lifetime.scope, { kind: 'session', sessionId }, listener)
        : () => undefined, [lifetime, sessionId]);
    // Observe only the selection token: typing remains subscribed in the composer leaf.
    const selectionMutationId = React.useSyncExternalStore(subscribeSelection, readSelectionMutationId, readSelectionMutationId);
    const createState = () => {
        const document = lifetime ? getSessionDraftSnapshot(lifetime.scope, address)?.document : null;
        const saved = SelectionSchema.safeParse(getSessionDraftDocumentField(document ?? null, selectionPath)?.value);
        return { key, selectionMutationId, identity: saved.success ? saved.data.identity : {
            correlationId: input.correlationId ?? randomUUID(), inputLocalId: randomUUID(),
        }, actionInput: saved.success ? saved.data.actionInput : input.createDefaultInput() };
    };
    const [stored, setStored] = React.useState(createState);
    const matches = stored.key === key && stored.selectionMutationId === selectionMutationId;
    const current = matches ? stored : createState();
    if (!matches) setStored(current);
    const currentRef = React.useRef(current);
    currentRef.current = current;
    const persistSelection = React.useCallback(() => {
        if (!lifetime?.isCurrent() || currentRef.current.key !== key) return;
        const { identity, actionInput } = currentRef.current;
        writeExistingSessionDraft({ scope: lifetime.scope, sessionId,
            patch: { executionRunLauncher: { key: draftKey, patch: {
                selection: StrictJsonValueSchema.parse({ identity, actionInput }),
            } } } });
    }, [draftKey, key, lifetime, sessionId]);
    const setActionInput = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>((update) => {
        if (currentRef.current.key !== key) return;
        const previous = currentRef.current;
        const actionInput = typeof update === 'function' ? update(previous.actionInput) : update;
        if (actionInput === previous.actionInput) return;
        currentRef.current = { ...previous, actionInput };
        setStored(currentRef.current);
    }, [key]);
    const setUserActionInput = React.useCallback<React.Dispatch<React.SetStateAction<Record<string, unknown>>>>((update) => {
        setActionInput(update);
        persistSelection();
    }, [persistSelection, setActionInput]);
    return {
        identity: current.identity,
        actionInput: current.actionInput,
        setActionInput,
        setUserActionInput,
        onDocumentEdit: persistSelection,
        setIdentity: (identity: typeof current.identity) => {
            currentRef.current = { ...currentRef.current, identity };
            setStored(currentRef.current);
            persistSelection();
        },
        captureSelection: (): SessionDraftCurrentness | null => lifetime?.isCurrent()
            ? captureSessionDraftCurrentness({ scope: lifetime.scope, address, fieldIds: [selectionFieldId] }) : null,
        clearAcceptedSelection: (capture: SessionDraftCurrentness | null, residual: ParticipantComposerDocument) => {
            if (!capture || !lifetime?.isCurrent() || residual.text || residual.mentions.length || residual.attachments.length) return;
            clearSessionDraftCurrentnessLocal({ scope: lifetime.scope, address, currentness: capture, fieldIds: [selectionFieldId] });
        },
    };
}
