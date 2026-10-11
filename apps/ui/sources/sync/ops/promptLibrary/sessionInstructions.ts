import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

export type SessionInstructionsTarget = Readonly<{
    sessionId: string;
    serverId: string;
    expectedMetadataRevision: number;
}>;

export type SessionInstructionsAuthoringDraft = Readonly<{ title: string; markdown: string }>;
export type SessionInstructionsAuthoringResult = Readonly<{
    result: ActionExecuteResult;
    createdRef: PromptDocArtifactRefV1 | null;
    /** The caller retains its draft until the attachment result is accepted. */
    draft: SessionInstructionsAuthoringDraft;
}>;

/** Device-local unsaved authoring recovers only the two known editor fields. */
export function readSessionInstructionsAuthoringDraft(value: unknown): SessionInstructionsAuthoringDraft | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const title: unknown = Reflect.get(value, 'title');
    const markdown: unknown = Reflect.get(value, 'markdown');
    return typeof title === 'string' && typeof markdown === 'string' ? { title, markdown } : undefined;
}

function execute(
    actionId: ActionId,
    input: unknown,
    context: UiActionExecutorContext,
    executeAction?: MountedAuthoringActionExecute,
): Promise<ActionExecuteResult> {
    return executeAction ? executeAction(actionId, input, { signal: context.signal })
        : createFrontDoorActionExecute()(actionId, input, context);
}

async function createWithExecutor(
    context: UiActionExecutorContext & Readonly<{ serverId: string }>,
    draft: SessionInstructionsAuthoringDraft,
    executeAction?: MountedAuthoringActionExecute,
): Promise<SessionInstructionsAuthoringResult> {
    const created = await execute('prompt_doc.create', draft, context, executeAction);
    if (!created.ok || ActionApprovalRequestCreatedResultSchema.safeParse(created.result).success)
        return { result: created, createdRef: null, draft };
    const output: unknown = getActionSpec('prompt_doc.create').outputSchema?.parse(created.result);
    const ref = PromptDocArtifactRefV1Schema.parse({ kind: 'doc', serverId: context.serverId,
        artifactId: output && typeof output === 'object' && 'artifactId' in output ? output.artifactId : undefined });
    return { result: created, createdRef: ref, draft };
}

async function create(serverId: string, draft: SessionInstructionsAuthoringDraft,
    signal?: AbortSignal, expectedAccountId?: string,
    executeAction?: MountedAuthoringActionExecute): Promise<SessionInstructionsAuthoringResult> {
    return createWithExecutor({
        serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}),
        ...(expectedAccountId !== undefined ? { expectedAccountId } : {}),
    }, draft, executeAction);
}

async function set(target: SessionInstructionsTarget, ref: PromptDocArtifactRefV1 | null, signal?: AbortSignal,
    executeAction?: MountedAuthoringActionExecute): Promise<ActionExecuteResult> {
    return execute('session.instructions.set', { ...target, ref }, {
        serverId: target.serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}),
    }, executeAction);
}

async function createAndAttach(target: SessionInstructionsTarget, draft: SessionInstructionsAuthoringDraft,
    signal?: AbortSignal, executeAction?: MountedAuthoringActionExecute): Promise<SessionInstructionsAuthoringResult> {
    // Validate the exact reviewed Session target before creating a reusable document.
    getActionSpec('session.instructions.set').inputSchema.parse({ ...target, ref: null });
    const context = { serverId: target.serverId, surface: 'ui', authority: 'present_user', ...(signal ? { signal } : {}) } as const;
    const created = await createWithExecutor(context, draft, executeAction);
    if (!created.createdRef) return created;
    const ref = created.createdRef;
    // A conflict or an unknown attachment outcome keeps the created document reusable.
    const result = await execute('session.instructions.set', { ...target, ref }, context, executeAction);
    return { result, createdRef: ref, draft };
}

/** Work and authoring share the public Actions, never a metadata or Artifact writer. */
export const sessionInstructionsActions = { set, create, createAndAttach };
