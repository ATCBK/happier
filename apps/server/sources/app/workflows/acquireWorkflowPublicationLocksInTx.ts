import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { getWorkflowPublicationAudienceInTx, type WorkflowPublicationScope } from "./workflowPublicationAudience";

/** Acquire the composed union before any owner mode, Run, trigger or Session write fence. */
export async function acquireWorkflowPublicationLocksInTx(tx: Tx, scope: WorkflowPublicationScope): Promise<void> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return;
    const captured = await getWorkflowPublicationAudienceInTx(tx, scope);
    await acquireSessionAccountCursorLocksInTx(tx, captured.sessionIds, captured.accountIds);
    const current = await getWorkflowPublicationAudienceInTx(tx, scope);
    const accounts = new Set(captured.accountIds);
    const sessions = new Set(captured.sessionIds);
    if (current.accountIds.some(accountId => !accounts.has(accountId))
        || current.sessionIds.some(sessionId => !sessions.has(sessionId))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
}
