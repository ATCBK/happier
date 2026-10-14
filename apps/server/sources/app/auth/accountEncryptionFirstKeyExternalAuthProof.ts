import type { AccountEncryptionMigrateExternalAuthProof, AccountEncryptionMigrateExternalAuthBindingDigestV1 } from '@happier-dev/protocol/account/encryptionMigrate';

import type { Tx } from "@/storage/inTx";
import {
    consumeAccountEncryptionFirstKeyStepUpPendingInTx,
    consumeAccountPasswordEnrollmentStepUpPendingInTx,
    type AccountEncryptionFirstKeyStepUpConsumeResult,
} from "@/app/api/routes/connect/connectRoutes.oauthPending";
import {
    consumeMtlsFirstKeyStepUpClaimInTx,
    consumeMtlsPasswordEnrollmentStepUpClaimInTx,
} from "./providers/mtls/mtlsClaimCode";
import {
    isEffectiveHomeAuthMethodActionEnabledInTx,
} from "@/app/auth/methods/effectiveHomeAuthMethods";

export async function consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1;
        externalAuthProof:
            AccountEncryptionMigrateExternalAuthProof;
    }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    if (params.externalAuthProof.provider === "mtls") {
        const methodCurrent =
            await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env: process.env,
                methodId: "mtls",
                actionId: "login",
                mode: "keyless",
            });
        return await consumeMtlsFirstKeyStepUpClaimInTx(
            tx,
            {
                accountId: params.accountId,
                pending: params.externalAuthProof.pending,
                proof: params.externalAuthProof.proof,
                requestDigest: params.requestDigest,
                methodCurrent,
            },
        );
    }
    return await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
        tx,
        {
            accountId: params.accountId,
            provider: params.externalAuthProof.provider,
            pending: params.externalAuthProof.pending,
            proof: params.externalAuthProof.proof,
            requestDigest: params.requestDigest,
        },
    );
}

export async function consumeAccountPasswordEnrollmentExternalAuthProofInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        requestDigest: string;
        externalAuthProof: AccountEncryptionMigrateExternalAuthProof;
    }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    if (params.externalAuthProof.provider === "mtls") {
        const methodCurrent =
            await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env: process.env,
                methodId: "mtls",
                actionId: "login",
                mode: "keyless",
            });
        return await consumeMtlsPasswordEnrollmentStepUpClaimInTx(tx, {
            accountId: params.accountId,
            pending: params.externalAuthProof.pending,
            proof: params.externalAuthProof.proof,
            requestDigest: params.requestDigest,
            methodCurrent,
        });
    }
    return await consumeAccountPasswordEnrollmentStepUpPendingInTx(tx, {
        accountId: params.accountId,
        provider: params.externalAuthProof.provider,
        pending: params.externalAuthProof.pending,
        proof: params.externalAuthProof.proof,
        requestDigest: params.requestDigest,
    });
}
