import { randomBytes } from "node:crypto";
import { createNativeAuthOneTimeOperationKeyV1, decodeNativeAuthOneTimeOperationV1, encodeNativeAuthOneTimeOperationV1, NATIVE_AUTH_EMAIL_VERIFY_TTL_MS, NATIVE_AUTH_ONE_TIME_BEARER_BYTES, NATIVE_AUTH_PASSWORD_RESET_TTL_MS, NativeAuthOneTimeBearerV1Schema, type NativeAuthOneTimeOperationV1, type NativeAuthOneTimePurpose } from '@happier-dev/protocol/auth/nativeAuthOneTimeOperation';

import { deleteRepeatKeyExact, fetchRepeatKey, saveRepeatKey } from "@/storage/queue/repeatKey";
import type { Tx } from "@/storage/inTx";

const TTL_MS_BY_PURPOSE = {
    verify_native_email: NATIVE_AUTH_EMAIL_VERIFY_TTL_MS,
    reset_plain_password: NATIVE_AUTH_PASSWORD_RESET_TTL_MS,
} as const satisfies Record<NativeAuthOneTimePurpose, number>;

export type NativeAuthClock = Readonly<{ now?: () => Date }>;

export type IssuedNativeAuthOneTimeOperation = Readonly<{
    /** Belongs only in the operation's canonical URL path; never stored or logged. */
    rawBearer: string;
    expiresAt: Date;
}>;

function currentDate(clock?: NativeAuthClock): Date {
    return clock?.now ? clock.now() : new Date();
}

function resolveOperationKey(purpose: NativeAuthOneTimePurpose, token: string): string | null {
    if (!NativeAuthOneTimeBearerV1Schema.safeParse(token).success) return null;
    return createNativeAuthOneTimeOperationKeyV1(purpose, token);
}

/**
 * Creates one expiring digest-addressed operation record. The caller commits
 * this transaction before attempting delivery, so a failed email never leaves a
 * bearer that was never persisted.
 */
export async function issueNativeAuthOneTimeOperationInTx(
    tx: Tx,
    operation: NativeAuthOneTimeOperationV1,
    clock?: NativeAuthClock,
): Promise<IssuedNativeAuthOneTimeOperation> {
    const rawBearer = randomBytes(NATIVE_AUTH_ONE_TIME_BEARER_BYTES).toString("base64url");
    const expiresAt = new Date(currentDate(clock).getTime() + TTL_MS_BY_PURPOSE[operation.purpose]);
    await saveRepeatKey(
        tx,
        createNativeAuthOneTimeOperationKeyV1(operation.purpose, rawBearer),
        encodeNativeAuthOneTimeOperationV1(operation),
        expiresAt.getTime(),
    );
    return { rawBearer, expiresAt };
}

/**
 * Read-only preview. Expired, missing, malformed, wrong-purpose, and already
 * consumed bearers are indistinguishable here on purpose.
 */
export async function readNativeAuthOneTimeOperation(
    tx: Tx,
    params: Readonly<{ purpose: NativeAuthOneTimePurpose; token: string }>,
    clock?: NativeAuthClock,
): Promise<NativeAuthOneTimeOperationV1 | null> {
    const key = resolveOperationKey(params.purpose, params.token);
    if (!key) return null;
    const raw = await fetchRepeatKey(tx, key, currentDate(clock));
    if (raw === null) return null;
    const operation = decodeNativeAuthOneTimeOperationV1(raw);
    return operation?.purpose === params.purpose ? operation : null;
}

/**
 * Consumption is the exact guarded deletion, and callers must run it inside the
 * same transaction as the mutation it authorizes. Exactly one concurrent caller
 * observes the operation; the rest see `null`.
 */
export async function consumeNativeAuthOneTimeOperationInTx(
    tx: Tx,
    params: Readonly<{ purpose: NativeAuthOneTimePurpose; token: string }>,
    clock?: NativeAuthClock,
): Promise<NativeAuthOneTimeOperationV1 | null> {
    const key = resolveOperationKey(params.purpose, params.token);
    if (!key) return null;
    const now = currentDate(clock);
    const raw = await fetchRepeatKey(tx, key, now);
    if (raw === null) return null;
    const operation = decodeNativeAuthOneTimeOperationV1(raw);
    if (operation?.purpose !== params.purpose) return null;
    return await deleteRepeatKeyExact(tx, key, raw, now) ? operation : null;
}
