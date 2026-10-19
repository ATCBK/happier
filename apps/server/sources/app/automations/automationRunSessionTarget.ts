import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { parseAutomationRunExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { Tx } from '@/storage/inTx';
import { readRetainedAutomationRunExecutionTargetV2 } from './automationStoredContentRead';

/** Only a strict new-Session recipe owns its immutable Automation creation tag. */
export function deriveStrictNewSessionCreationTag(params: {
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
}): string | null {
    if (params.originKind !== "automation" || params.automationId === null) return null;
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    if (recipe.kind !== "available" || recipe.recipe.target.kind !== "newSession") return null;
    return deriveSessionCreationTagV1({
        callerCreationNamespace: `automation:${params.automationId}`,
        creationKey: `automation-run:${params.runId}`,
    });
}

export async function findStrictNewSessionByRunCreationTagTx(params: {
    tx: Tx;
    accountId: string;
    originKind: string;
    automationId: string | null;
    runId: string;
    executionInputEnvelope: string | null;
}): Promise<{ id: string } | null> {
    const sessionCreationTag = deriveStrictNewSessionCreationTag(params);
    if (!sessionCreationTag) return null;
    return await params.tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: params.accountId,
                tag: sessionCreationTag,
            },
        },
        select: { id: true },
    });
}

async function findNewSessionByRunCreationTagTx(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
}): Promise<{ id: string } | null> {
    const sessionCreationTag = deriveSessionCreationTagV1({
        callerCreationNamespace: `automation:${params.automationId}`,
        creationKey: `automation-run:${params.runId}`,
    });
    return await params.tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: params.accountId,
                tag: sessionCreationTag,
            },
        },
        select: { id: true },
    });
}

/** The pending-input target reader shared by cancellation and its entry census. */
export async function resolveAutomationPendingInputSessionIdTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    automationId: string;
    runId: string;
    executionInputEnvelope: string | null;
    accountEncryptionMode: "plain" | "e2ee";
    retainedV2OriginKind: "scheduled" | "manual" | undefined;
}>): Promise<string | null> {
    const recipe = parseAutomationRunExecutionRecipeV1(params.executionInputEnvelope);
    if (recipe.kind === "available" && recipe.recipe.target.kind === "existingSession") {
        const session = await params.tx.session.findFirst({
            where: {
                id: recipe.recipe.target.sessionId,
                accountId: params.accountId,
            },
            select: { id: true },
        });
        return session?.id ?? null;
    }
    if (recipe.kind === "available" && recipe.recipe.target.kind === "newSession") {
        const session = await findStrictNewSessionByRunCreationTagTx({
            ...params,
            originKind: "automation",
        });
        return session?.id ?? null;
    }
    if (recipe.kind === "available") return null;

    const retainedTarget = params.executionInputEnvelope === null
        || params.retainedV2OriginKind === undefined
        ? null
        : readRetainedAutomationRunExecutionTargetV2({
            raw: params.executionInputEnvelope,
            mode: params.accountEncryptionMode,
            retainedV2OriginKind: params.retainedV2OriginKind,
        });
    if (retainedTarget?.kind === "existingSession") {
        const session = await params.tx.session.findFirst({
            where: { id: retainedTarget.sessionId, accountId: params.accountId },
            select: { id: true },
        });
        return session?.id ?? null;
    }
    if (retainedTarget?.kind !== "newSession") return null;
    const session = await findNewSessionByRunCreationTagTx(params);
    return session?.id ?? null;
}
