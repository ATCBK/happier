import { isPrismaErrorCode } from "@/storage/prisma";
import { discussionFailure, type DiscussionFailureCode, type DiscussionResult } from './serviceTypes';

/** A declined initial invitation must unwind the entire create transaction before returning its refusal. */
export class DiscussionCreationRejectedError extends Error {
    constructor(readonly code: DiscussionFailureCode) {
        super(code);
        this.name = 'DiscussionCreationRejectedError';
    }
}

const DISCUSSION_CREATION_IDENTITY_CONSTRAINT = "Discussion_createdByAccountId_creationLocalId_key";

function readPrismaUniqueMetadata(
    error: unknown,
): Readonly<{ modelName: unknown; target: unknown }> | undefined {
    if (error === null || typeof error !== "object" || !("meta" in error)) return undefined;
    const meta = (error as { meta?: unknown }).meta;
    if (meta === null || typeof meta !== "object") return { modelName: undefined, target: undefined };
    const record = meta as { modelName?: unknown; target?: unknown };
    return { modelName: record.modelName, target: record.target };
}

/**
 * Identifies only the database identity used to adjudicate Discussion-create
 * replay. Other unique failures are defects and must remain visible rather than
 * being reinterpreted as idempotency races.
 */
export function isDiscussionCreationIdentityConflict(error: unknown): boolean {
    if (!isPrismaErrorCode(error, "P2002")) return false;
    const metadata = readPrismaUniqueMetadata(error);
    if (metadata === undefined) return false;
    if (typeof metadata.modelName === "string" && metadata.modelName !== "Discussion") return false;
    const { target } = metadata;
    if (typeof target === "string") {
        return target === DISCUSSION_CREATION_IDENTITY_CONSTRAINT;
    }
    return Array.isArray(target)
        && target.length === 2
        && target.includes("createdByAccountId")
        && target.includes("creationLocalId");
}

/**
 * A concurrent insert can invalidate the create transaction's initial identity
 * lookup. Restart the complete domain transaction once so its existing-row
 * actor/equality checks adjudicate the winner from committed state.
 */
export async function reconcileDiscussionCreationIdentityRace<T>(
    operation: () => Promise<T>,
): Promise<T | DiscussionResult<never>> {
    const attempt = async () => {
        try { return await operation(); }
        catch (error) {
            if (error instanceof DiscussionCreationRejectedError) return discussionFailure(error.code);
            throw error;
        }
    };
    try {
        return await attempt();
    } catch (error) {
        if (!isDiscussionCreationIdentityConflict(error)) throw error;
        return await attempt();
    }
}
