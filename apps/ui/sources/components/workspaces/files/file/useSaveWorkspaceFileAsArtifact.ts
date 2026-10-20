import * as React from 'react';
import type { ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { createArtifactActionsClient, type ArtifactActionFailure } from '@/components/artifacts/artifactActionsClient';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type Receipt = ArtifactActionResultV1<'artifact.publish_from_file'>;
type Visibility = 'private' | 'team';
type Status = Readonly<{ kind: 'idle' | 'publishing' }>
    | Readonly<{ kind: 'sharing' | 'saved'; receipt: Receipt }>
    | Readonly<{ kind: 'failed'; failure: ArtifactActionFailure; receipt?: Receipt }>
    | Readonly<{ kind: 'approval'; approvalId: string; receipt?: Receipt }>;
type Dialog = Readonly<{ identity: string; isOpen: boolean; title: string; visibility: Visibility; status: Status }>;

/** The PAGE surface renders this model; publication and audience changes use the existing Artifact Actions. */
export function useSaveWorkspaceFileAsArtifact(input: Readonly<{
    /** Captured from the source File's Account, rather than the currently focused Home. */
    scope: ServerAccountScope | null;
    sourceSessionId: string | null;
    filePath: string;
    team?: Readonly<{ teamId: string; name: string }> | null;
}>) {
    const scope = React.useMemo(() => input.scope ? { serverId: input.scope.serverId, accountId: input.scope.accountId } : null,
        [input.scope?.serverId, input.scope?.accountId]);
    const identity = JSON.stringify([scope?.serverId, scope?.accountId, input.sourceSessionId, input.filePath, input.team?.teamId]);
    const fileName = input.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? input.filePath;
    const initial = (): Dialog => ({ identity, isOpen: false, title: fileName, visibility: 'private', status: { kind: 'idle' } });
    const [dialog, setDialog] = React.useState<Dialog>(initial);
    const currentIdentity = React.useRef(identity);
    currentIdentity.current = identity;
    const submission = React.useRef<object | null>(null);
    if (dialog.identity !== identity) {
        submission.current = null;
        setDialog(initial());
    }
    React.useEffect(() => () => { submission.current = null; }, []);
    const mounted = useMountedActionExecution(dialog.isOpen && dialog.identity === identity ? scope : null,
        { openOnRequest: true, retainInvocation: true });
    const client = React.useMemo(() => scope ? createArtifactActionsClient(scope, (actionId, actionInput, context) => mounted.execute(actionId, actionInput, {
        ...(context?.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
        ...(context?.presentUserConfirmation ? { presentUserConfirmation: context.presentUserConfirmation } : {}),
    })) : null, [scope, mounted.execute]);
    const busy = dialog.status.kind === 'publishing' || dialog.status.kind === 'sharing';
    const receipt = 'receipt' in dialog.status ? dialog.status.receipt : undefined;
    const available = Boolean(scope && input.sourceSessionId);
    const canSubmit = available && mounted.ready && dialog.isOpen && !busy && dialog.status.kind !== 'approval' && dialog.status.kind !== 'saved';
    const submit = async (): Promise<string | null> => {
        const sessionId = input.sourceSessionId;
        if (!canSubmit || !client || !sessionId || submission.current) return null;
        const run = {};
        submission.current = run;
        const isCurrent = () => submission.current === run && currentIdentity.current === identity;
        let published = receipt;
        const update = (status: Status) => { if (isCurrent()) setDialog(previous => ({ ...previous, status })); };
        try {
            if (!published) {
                update({ kind: 'publishing' });
                const result = await client.publishWorkspaceFile({ path: input.filePath, title: dialog.title }, { sessionId });
                if (!isCurrent()) return null;
                if ('approvalId' in result) { update({ kind: 'approval', approvalId: result.approvalId }); return null; }
                if (!result.ok) { update({ kind: 'failed', failure: result.failure }); return null; }
                published = result.value;
            }
            if (dialog.visibility === 'team') {
                const team = input.team;
                if (!team) { update({ kind: 'failed', receipt: published, failure: { code: 'artifact_team_unavailable' } }); return null; }
                update({ kind: 'sharing', receipt: published });
                const result = await client.setAccessGrant({ artifactId: published.artifactId,
                    principal: { kind: 'team', teamId: team.teamId }, accessLevel: 'view' });
                if (!isCurrent()) return null;
                if ('approvalId' in result) { update({ kind: 'approval', approvalId: result.approvalId, receipt: published }); return null; }
                if (!result.ok) { update({ kind: 'failed', failure: result.failure, receipt: published }); return null; }
            }
            update({ kind: 'saved', receipt: published });
            return published.artifactId;
        } catch {
            update({ kind: 'failed', failure: { code: 'artifact_action_failed' }, ...(published ? { receipt: published } : {}) });
            return null;
        } finally {
            if (submission.current === run) submission.current = null;
        }
    };
    return {
        isOpen: dialog.isOpen, title: dialog.title, visibility: dialog.visibility, status: dialog.status,
        approval: mounted.approval,
        team: input.team ?? null, available, unavailableReason: available ? null : 'artifact_source_unavailable',
        busy, canSubmit, canEditFields: !busy && !receipt && dialog.status.kind !== 'approval',
        open: () => { if (!busy) setDialog({ ...initial(), isOpen: true }); },
        dismiss: () => { if (!busy) setDialog(previous => ({ ...previous, isOpen: false })); },
        setTitle: (title: string) => { if (!busy && !receipt && dialog.status.kind !== 'approval') setDialog(previous => ({ ...previous, title })); },
        setVisibility: (visibility: Visibility) => {
            if (!busy && !receipt && dialog.status.kind !== 'approval' && (visibility === 'private' || input.team)) setDialog(previous => ({ ...previous, visibility }));
        },
        submit,
    };
}
