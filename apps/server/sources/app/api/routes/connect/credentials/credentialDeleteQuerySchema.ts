import { z } from "zod/mini";
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

function parseBooleanQueryFlag(value: unknown): unknown {
    if (typeof value !== "string") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
}

export const ConnectedServiceCredentialDeleteQuerySchema = z.strictObject({
    cleanupGroupReferences: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(parseBooleanQueryFlag), z.optional(z.boolean())),
    expectedCredentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
});
