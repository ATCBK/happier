import { readSharedQaSchemaMismatchDiagnostic } from "@/storage/prismaErrors";

/** The handshake's existing infrastructure failure classification also governs packets. */
export function resolveSocketAuthUnavailableError(error: unknown) {
    return { statusCode: 503, ...(readSharedQaSchemaMismatchDiagnostic(error) ?? { error: "upstream_error" }) };
}

/** Socket authentication failures carry the existing transport status envelope. */
export function rejectSocket(params: { statusCode: number; error: string; message?: string; provider?: string; data?: Record<string, unknown> }) {
    const err: Error & { data?: Record<string, unknown> } = new Error(params.message ?? params.error);
    err.data = {
        error: params.error,
        statusCode: params.statusCode,
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.data ?? {}),
    };
    return err;
}
