import { randomUUID } from "node:crypto";

import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { markAccountChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProjection";
import { publishAccountCredentialSourceTeamsChangedInTx } from "@/app/teams/teamChanges";

export async function recordConnectedServiceAccountProfileChange(params: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<AccountChangePublication> {
    const projection = await buildAccountConnectedServicesProjection({
        tx: params.tx,
        accountId: params.accountId,
        includeGroups: await isServerFeatureEnabledForHome("connectedServices.accountGroups", { tx: params.tx }),
    });
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "self",
        hint: { connectedServices: true },
    });
    await publishAccountCredentialSourceTeamsChangedInTx(params.tx, { accountId: params.accountId });
    afterTx(params.tx, () => {
        const payload = buildUpdateAccountUpdate(
            params.accountId,
            projection,
            cursor.resolveCursor(),
            randomUUID(),
        );
        eventRouter.emitUpdate({
            userId: params.accountId,
            recipientFilter: { type: "user-machine-scoped-only" },
            payload,
        });
        eventRouter.emitUpdate({
            userId: params.accountId,
            recipientFilter: { type: "user-scoped-only" },
            payload,
        });
    });
    return cursor;
}
