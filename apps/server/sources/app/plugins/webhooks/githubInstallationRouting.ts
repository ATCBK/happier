import { PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1 } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';

const INSTALLATION_ID_PATTERN_V1 = /^[1-9][0-9]{0,19}$/u;

/**
 * Canonical verified-installation parser for the generic GitHub
 * `providerInstallationId` seam.
 *
 * The body is already size-capped by `readWebhookRawBodyV1` at
 * `PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1`, so `JSON.parse` here is bounded by
 * that same limit. Callers must invoke this only after the HMAC verifier has
 * accepted the exact raw bytes (see `ingest.ts`); the returned id is never
 * trusted for routing or effects before verification.
 *
 * Precision closes at `Number.MAX_SAFE_INTEGER`: bounded `JSON.parse` cannot
 * preserve larger decimal identities, so those fail closed as
 * `malformedInstallation` rather than routing the wrong installation.
 */
export function extractVerifiedGitHubInstallationIdV1(rawBody: Uint8Array):
    | Readonly<{ ok: true; installationId: string }>
    | Readonly<{ ok: false; code: "malformedPayload" | "malformedInstallation" }> {
    if (rawBody.byteLength > PLUGIN_WEBHOOK_MAX_RAW_BODY_BYTES_V1) {
        return { ok: false, code: "malformedPayload" };
    }
    let source: string;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch {
        return { ok: false, code: "malformedPayload" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(source) as unknown;
    } catch {
        return { ok: false, code: "malformedPayload" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, code: "malformedInstallation" };
    }
    const installation = (parsed as Readonly<Record<string, unknown>>).installation;
    if (typeof installation !== "object" || installation === null || Array.isArray(installation)) {
        return { ok: false, code: "malformedInstallation" };
    }
    const id = (installation as Readonly<Record<string, unknown>>).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
        return { ok: false, code: "malformedInstallation" };
    }
    const token = String(id);
    return INSTALLATION_ID_PATTERN_V1.test(token)
        ? { ok: true, installationId: token }
        : { ok: false, code: "malformedInstallation" };
}
