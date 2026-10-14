import type { ReviewCommentOperationErrorCodeV1 } from '@happier-dev/protocol/reviews/comments/actions';

export class ReviewCommentOperationError extends Error {
    constructor(
        readonly code: ReviewCommentOperationErrorCodeV1,
        message: string,
    ) {
        super(message);
        this.name = "ReviewCommentOperationError";
    }
}
