import { AutomationConversationTargetsListInputV1Schema, AutomationConversationTargetsListResultV1Schema, AutomationConversationTargetVerifyResultV1Schema, type AutomationConversationTargetsListResultV1, type AutomationConversationTargetVerifyResultV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { AutomationConversationActionHttpRequestSchemasV1 } from '@happier-dev/protocol/automations/event';
import { type AutomationConversationScopedTriggerRefV1 } from '@happier-dev/protocol/automations/result-delivery';
import { openAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationPullRequestTriggerSchema } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx, type Tx } from "@/storage/inTx";

import { loadAutomationTx } from "./automationCrudService";
import type { AutomationTargetType } from "./automationTypes";
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";

/**
 * Any plugin may bind a conversation to an Automation the Account owns, so the
 * only caller question left here is whether the host-stamped materialization is
 * still current for this Account. Which plugin is asking is not an authority
 * input; the ActionSpec declaration and its executor own that decision.
 */
export class AutomationConversationTargetVerificationCallerError extends Error {
    constructor() {
        super("automation_conversation_target_caller_not_current");
        this.name = "AutomationConversationTargetVerificationCallerError";
    }
}

async function assertCurrentAutomationConversationTargetCallerTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    caller: AutomationEventCallerV1;
}>): Promise<void> {
    try {
        await assertCurrentAutomationEventCallerMaterializationTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) {
            throw new AutomationConversationTargetVerificationCallerError();
        }
        throw error;
    }
}

function readAutomationConversationTargetLabel(row: Readonly<{ id: string; name: string }>): string {
    const name = row.name.trim();
    return name.length >= 1 && name.length <= 128 ? name : row.id;
}

/**
 * Canonical capability decision shared by target verification and the final
 * admission writer. `executionRun` currently has no truthful text-result
 * producer, while both Session targets settle through the exact-turn result
 * owner.
 */
export function classifyAutomationConversationTargetEligibilityV1(params: Readonly<{
    targetType: AutomationTargetType | null;
    resultDelivery: "none" | "finalResult";
}>): "eligible" | "resultDeliveryUnsupported" {
    return params.resultDelivery === "finalResult" && params.targetType === "execution_run"
        ? "resultDeliveryUnsupported"
        : "eligible";
}

/** The trigger row and Account-mode envelope remain the correspondence authority. */
export async function matchesScopedAutomationConversationTriggerTx(params: Readonly<{
    tx: Tx; accountId: string; automationId: string; scopeSessionId: string | null;
    scopedTrigger: AutomationConversationScopedTriggerRefV1 | Omit<AutomationConversationScopedTriggerRefV1, 'pullRequest'> | undefined;
    requireEnabled?: boolean;
    matchPullRequest?: boolean;
}>): Promise<boolean> {
    const ref = params.scopedTrigger;
    if (!ref) return params.scopeSessionId === null;
    if (params.scopeSessionId !== ref.sessionId) return false;
    const row = await params.tx.automationTrigger.findFirst({ where: {
        id: ref.triggerId, automationId: params.automationId, ...(params.requireEnabled === false ? {} : { enabled: true }), deletedAt: null,
    } });
    if (!row || row.kind !== ref.triggerKind || row.revision !== ref.triggerRevision || row.sourceSessionId !== ref.sessionId || !row.definitionEnvelope) return false;
    const account = await params.tx.account.findUnique({ where: { id: params.accountId }, select: { encryptionMode: true } });
    if (!account) return false;
    let envelope: unknown;
    try { envelope = JSON.parse(row.definitionEnvelope); } catch { return false; }
    const mode = account.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode, envelope,
        binding: { v: 1, automationId: params.automationId, triggerId: ref.triggerId,
            triggerRevision: row.revision, triggerKind: ref.triggerKind } });
    // E2EE selection is attested by the current authenticated host, which alone
    // can open the private definition. Public row correspondence is still checked here.
    if (mode === 'e2ee') return opened.kind === 'materialUnavailable';
    if (opened.kind !== 'available') return false;
    const definition = AutomationPullRequestTriggerSchema.safeParse(opened.definition);
    return definition.success && definition.data.kind === ref.triggerKind
        && (params.matchPullRequest === false || ('pullRequest' in ref
            && createCanonicalJsonSigningInput(definition.data.pullRequest) === createCanonicalJsonSigningInput(ref.pullRequest)));
}

/**
 * Side-effect-free target verification for conversation-binding persistence.
 * A conversation binding is an additional invocation source for an Automation
 * the Account already owns, so trigger kind does not restrict the target and
 * several bindings may name the same one. The selected result-delivery policy
 * must still be supported by that Automation's execution target.
 * Automation storage and plugin-materialization currentness remain at their
 * incumbent owners; this projection returns no definition bytes or replacement
 * version.
 */
export async function verifyAutomationConversationTargetV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetVerifyResultV1> {
    const input = AutomationConversationActionHttpRequestSchemasV1['automation.conversation.target.verify'].shape.input.parse(params.input);
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await inTx(async (tx) => {
        await assertCurrentAutomationConversationTargetCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: input.automationId,
        });
        if (!automation) {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: "notFound",
            });
        }
        if (!await matchesScopedAutomationConversationTriggerTx({ tx, accountId: params.accountId,
            automationId: automation.id, scopeSessionId: automation.scopeSessionId, scopedTrigger: input.scopedTrigger,
            // The host binds the private selection; this read verifies only public row correspondence.
            requireEnabled: false, matchPullRequest: false })) {
            return AutomationConversationTargetVerifyResultV1Schema.parse({ kind: 'notVerified', reason: 'scopedTriggerIdentityMismatch' });
        }
        const eligibility = classifyAutomationConversationTargetEligibilityV1({
            targetType: automation.targetType,
            resultDelivery: input.resultDelivery ?? "none",
        });
        if (eligibility !== "eligible") {
            return AutomationConversationTargetVerifyResultV1Schema.parse({
                kind: "notVerified",
                reason: eligibility,
            });
        }
        return AutomationConversationTargetVerifyResultV1Schema.parse({
            kind: "verified",
        });
    }, { transactionClass: "automation-conversation-target-verify" });
}

/**
 * Current-materialization-scoped selector for conversation-binding
 * composition. Any Automation the Account owns can take a conversation as an
 * additional invocation source, so this projects every current Automation
 * independently of its zero-or-more automatic triggers. Verification remains the final authority at
 * binding create; this projection neither carries nor grants target execution
 * authority.
 */
export async function listAutomationConversationTargetsV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventCallerV1;
    input: unknown;
}>): Promise<AutomationConversationTargetsListResultV1> {
    const input = AutomationConversationTargetsListInputV1Schema.parse(params.input);
    const limit = input.limit ?? 100;
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);

    return await inTx(async (tx) => {
        await assertCurrentAutomationConversationTargetCallerTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });

        const rows = await tx.automation.findMany({
            where: {
                accountId: params.accountId,
                deletedAt: null,
                ...(input.cursor === undefined || input.cursor === null
                    ? {}
                    : { id: { gt: input.cursor } }),
            },
            orderBy: { id: "asc" },
            // One lookahead row so the picker's "Show more" affordance appears
            // only when a further Automation really exists, including when the
            // last page exactly fills the requested limit.
            take: limit + 1,
            select: {
                id: true,
                name: true,
                targetType: true,
                enabled: true,
            },
        });
        const page = rows.slice(0, limit);

        return AutomationConversationTargetsListResultV1Schema.parse({
            items: page.map((row) => ({
                automationId: row.id,
                label: readAutomationConversationTargetLabel(row),
                execution: {
                    targetType: row.targetType,
                    enabled: row.enabled,
                },
            })),
            nextCursor: rows.length > limit ? page[page.length - 1]?.id ?? null : null,
        });
    }, { transactionClass: "automation-conversation-target-list" });
}
