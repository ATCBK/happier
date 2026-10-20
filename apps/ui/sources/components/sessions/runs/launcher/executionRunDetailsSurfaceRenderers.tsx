import * as React from 'react';
import { DiscussionSelectionSourceV1Schema, type DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import type { DetailsSurfaceRendererV1 } from '@/components/appShell/panes/details/surfaces';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { SessionInteractiveExecutionRunDraftView } from './SessionInteractiveExecutionRunDraftView';
import { SessionExecutionRunDetailsView } from '../details/SessionExecutionRunDetailsView';
import { createExecutionRunDetailsTab } from './executionRunLauncherModel';

type Workspace = Readonly<{ machineId: string; cwd: string }>;
type RunResourceScope = Readonly<{ sessionId?: null; workspace?: Workspace }>;

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasValidScope(value: Record<string, unknown>): boolean {
    if (value.sessionId === undefined && value.workspace === undefined) return true;
    const workspace = record(value.workspace);
    return value.sessionId === null && workspace !== null
        && typeof workspace.machineId === 'string' && workspace.machineId.trim().length > 0
        && typeof workspace.cwd === 'string' && workspace.cwd.trim().length > 0;
}

function isLauncher(value: unknown): value is RunResourceScope & Readonly<{
    kind: 'executionRunLauncher'; mode?: 'conversation'; intent?: 'review' | 'plan' | 'delegate';
    source?: DiscussionSelectionSourceV1; initialInstructions?: string; roleId?: string;
}> {
    const item = record(value);
    if (!item || item.kind !== 'executionRunLauncher' || !hasValidScope(item)) return false;
    if (!(item.mode == null || item.mode === 'conversation')) return false;
    if (item.mode === 'conversation' && item.intent != null) return false;
    if (!(item.intent == null || item.intent === 'review' || item.intent === 'plan' || item.intent === 'delegate')) return false;
    if (item.initialInstructions != null && typeof item.initialInstructions !== 'string') return false;
    if (item.roleId != null && (typeof item.roleId !== 'string' || !item.roleId.trim())) return false;
    if (item.source == null) return true;
    const source = DiscussionSelectionSourceV1Schema.safeParse(item.source);
    return source.success && (item.mode !== 'conversation'
        || (typeof source.data.draftCorrelationId === 'string' && source.data.draftCorrelationId.trim().length > 0));
}

function isRun(value: unknown): value is RunResourceScope & Readonly<{
    kind: 'executionRun'; runId: string; retryInputLocalId?: string; initialText?: string;
}> {
    const item = record(value);
    return item !== null && item.kind === 'executionRun' && hasValidScope(item)
        && typeof item.runId === 'string' && item.runId.trim().length > 0
        && (item.retryInputLocalId === undefined || typeof item.retryInputLocalId === 'string' && item.retryInputLocalId.trim().length > 0)
        && (item.initialText === undefined || typeof item.initialText === 'string');
}

/** Session and workspace panes consume the same Run resources and lifecycle views. */
export function createExecutionRunDetailsSurfaceRenderers(options: Readonly<{
    owner: 'session' | 'workspace'; sessionId: string | null; serverId?: string | null;
    workspace?: Workspace; closeDetailsTab?: (key: string) => void;
}>): readonly DetailsSurfaceRendererV1[] {
    const scopeFor = (resource: RunResourceScope) => ({
        sessionId: resource.sessionId === null ? null : options.sessionId,
        workspace: resource.workspace ?? options.workspace,
    });
    return [{
        id: `${options.owner}-execution-run-launcher`, owner: options.owner, order: 70,
        canRender: input => isLauncher(input.tab.resource),
        render: input => {
            const resource = input.tab.resource;
            if (!isLauncher(resource)) return null;
            if (resource.source && (!options.serverId || !areServerProfileIdentifiersEquivalent(resource.source.serverId, options.serverId))) return null;
            const scope = scopeFor(resource);
            return <SessionInteractiveExecutionRunDraftView {...scope} serverId={options.serverId} autoFocusComposer
                intent={resource.mode === 'conversation' ? null : resource.intent ?? 'review'} roleId={resource.roleId ?? null}
                initialText={resource.initialInstructions}
                launchOrigin={resource.source && 'draftCorrelationId' in resource.source
                    ? resource.source as DiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }> : undefined}
                onRunStarted={(runId, recovery, presentation) => input.callbacks.replaceTab?.(input.tab.key,
                    createExecutionRunDetailsTab(runId, recovery, presentation?.title, scope.sessionId === null ? scope.workspace : undefined),
                    { intent: input.tab.isPreview ? 'preview' : 'pinned' })} />;
        },
    }, {
        id: `${options.owner}-execution-run`, owner: options.owner, order: 71,
        canRender: input => isRun(input.tab.resource),
        render: input => {
            const resource = input.tab.resource;
            if (!isRun(resource)) return null;
            return <SessionExecutionRunDetailsView {...scopeFor(resource)} serverId={options.serverId} runId={resource.runId}
                retryInputLocalId={resource.retryInputLocalId} initialText={resource.initialText} presentation="panel" openingTitle={input.tab.title}
                onRequestClose={() => (options.closeDetailsTab ?? input.callbacks.closeTab)?.(input.tab.key)}
                onTitleResolved={title => input.callbacks.replaceTab?.(input.tab.key,
                    { key: input.tab.key, kind: input.tab.kind, title, resource })} />;
        },
    }];
}
