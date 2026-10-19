import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ReviewFindingsV1Schema, type ReviewFindingsV1 } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { ReviewFindingsV2Schema, type ReviewFindingsV2 } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';

/** A review Run's structured result (findings v1 or v2), or null while it has none. */
export function readReviewPayload(meta: unknown, retainedFindings?: unknown): ReviewFindingsV1 | ReviewFindingsV2 | null {
    if (retainedFindings !== undefined) {
        const v2 = createStoredReadSchema(ReviewFindingsV2Schema).safeParse(retainedFindings);
        if (v2.success) return v2.data;
        const v1 = createStoredReadSchema(ReviewFindingsV1Schema).safeParse(retainedFindings);
        if (v1.success) return v1.data;
    }
    if (!meta || typeof meta !== 'object') return null;
    const { kind, payload } = meta as { kind?: unknown; payload?: unknown };
    if (kind === 'review_findings.v2') {
        const parsed = createStoredReadSchema(ReviewFindingsV2Schema).safeParse(payload);
        return parsed.success ? parsed.data : null;
    }
    if (kind === 'review_findings.v1') {
        const parsed = createStoredReadSchema(ReviewFindingsV1Schema).safeParse(payload);
        return parsed.success ? parsed.data : null;
    }
    return null;
}
