import type { AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';

import { parseAuthenticationEvidenceSnapshot } from "@/app/auth/authenticationEvidence";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { Tx } from "@/storage/inTx";

type ActivationAuthenticationRecord = Readonly<{ authenticationEvidence: unknown }>;

/**
 * Reads the server-owned credential snapshot for one exact activation.
 * Invalid or absent persisted data is an unqualified automation credential,
 * never a reason to infer evidence from the caller currently observing it.
 */
export function readRunnerActivationAuthenticationEvidence(
    row: ActivationAuthenticationRecord,
): readonly AuthTokenAuthenticationEvidenceV1[] | undefined {
    return parseAuthenticationEvidenceSnapshot(row.authenticationEvidence)?.evidence;
}

export function readRunnerActivationAuthentication(
    row: ActivationAuthenticationRecord,
    env: NodeJS.ProcessEnv,
): SessionAccessAuthentication {
    return {
        env,
        authority: "account_automation",
        authenticationEvidence: readRunnerActivationAuthenticationEvidence(row),
    };
}

/**
 * The same snapshot for a verified Runner principal that holds only its
 * activation identity. A missing or non-current activation resolves to an
 * unqualified automation credential, which the consuming owner then refuses —
 * never to inferred evidence.
 */
export async function readRunnerActivationAuthenticationInTx(
    tx: Tx,
    principal: Readonly<{ activationId: string; accountId: string }>,
    env: NodeJS.ProcessEnv = process.env,
): Promise<SessionAccessAuthentication> {
    const activation = await tx.ephemeralRunnerActivation.findFirst({
        where: { id: principal.activationId, creatorAccountId: principal.accountId },
        select: { authenticationEvidence: true },
    });
    return activation
        ? readRunnerActivationAuthentication(activation, env)
        : { env, authority: "account_automation", authenticationEvidence: undefined };
}
