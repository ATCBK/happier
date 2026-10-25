import { randomUUID } from "node:crypto";

import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { markAccountChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProjection";
import { publishAccountCredentialSourceTeamsChangedInTx } from "@/app/teams/teamChanges";
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { buildConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';
import { logger } from '@/utils/logging/log';

export async function recordConnectedServiceAccountProfileChange(params: Readonly<{
    tx: Tx;
    accountId: string;
    service?: QualifiedConnectedAccountServiceRef;
    reason?: 'credential-create' | 'credential-replace' | 'credential-delete' | 'credential-health'
        | 'legacy-credential' | 'configuration' | 'group' | 'group-delete' | 'encryption-migration';
}>): Promise<AccountChangePublication> {
    const projection = await buildAccountConnectedServicesProjection({
        tx: params.tx,
        accountId: params.accountId,
        includeGroups: await isServerFeatureEnabledForHome("connectedServices.accountGroups", { tx: params.tx }),
    });
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        ...buildConnectedServicesAccountChangeV1(params.service),
    });
    await publishAccountCredentialSourceTeamsChangedInTx(params.tx, { accountId: params.accountId, service: params.service });
    afterTx(params.tx, () => {
        logger.debug({ reason: params.reason ?? 'unspecified', serviceKind: params.service?.localId ?? null },
            'Connected service Account change committed');
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
