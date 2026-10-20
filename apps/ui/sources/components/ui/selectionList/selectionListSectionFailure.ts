/**
 * A failure a section's resolver names itself, in host copy.
 *
 * A resolver that knows why it failed (the folder is gone, the tool is missing on the machine) throws this
 * instead of a bare Error, so the line says the real cause and its next step. Sections whose failures share a
 * `causeKey` say it once, under the first of them. A section's own Retry link is offered only when the
 * descriptor names a `retryLabel` and the failure is retryable (the default).
 */
export class SelectionListSectionFailure extends Error {
    readonly hint: string;
    readonly causeKey: string | undefined;
    readonly retryable: boolean;

    constructor(input: Readonly<{ hint: string; causeKey?: string; retryable?: boolean }>) {
        super(input.hint);
        this.name = 'SelectionListSectionFailure';
        this.hint = input.hint;
        this.causeKey = input.causeKey;
        this.retryable = input.retryable !== false;
    }
}
