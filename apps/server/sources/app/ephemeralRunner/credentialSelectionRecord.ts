import { z } from "zod/mini";

import { RunnerCredentialSelectionBindingV1Schema } from "@happier-dev/protocol/ephemeralRunner/review";
import { RunnerCredentialSelectionResolutionRequestV1Schema } from "@happier-dev/protocol/teams";

/**
 * Server-owned record of the one credential selection resolved before Runner
 * review. It is deliberately stored on the existing activation aggregate: the
 * creator may seal and review this result, but cannot substitute another exact
 * broker Machine when publishing the review.
 */
export const StoredRunnerCredentialSelectionV1Schema = z.strictObject({
    v: z.literal(1),
    request: RunnerCredentialSelectionResolutionRequestV1Schema,
    binding: RunnerCredentialSelectionBindingV1Schema,
});

export type StoredRunnerCredentialSelectionV1 = z.infer<typeof StoredRunnerCredentialSelectionV1Schema>;
