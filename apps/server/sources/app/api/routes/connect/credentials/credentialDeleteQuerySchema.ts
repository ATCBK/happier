import { z } from "zod/mini";
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

function parseBooleanQueryFlag(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
}

export const ConnectedServiceCredentialDeleteQuerySchema = z.strictObject({
    cleanupGroupReferences: z.pipe(z.transform(parseBooleanQueryFlag), z.optional(z.boolean())),
    expectedCredentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
});
