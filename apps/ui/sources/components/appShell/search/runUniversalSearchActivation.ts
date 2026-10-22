/**
 * The single surface-level activation order: commit happens in the option
 * callback, this helper validates that committed identity, then dismisses the
 * host before awaiting the exact owner action. Keeping it explicit makes
 * currentness, focus restoration and error custody order testable without
 * mounting either platform host.
 */
export async function runUniversalSearchActivation(input: Readonly<{
    /** Query, close and workspace changes cancel preparation before custody passes to the destination. */
    isCurrent?(): boolean;
    prepare?(): boolean | Promise<boolean>;
    dismiss(): void;
    /** Null is a declined navigation, not a failed search. */
    activate(): Promise<boolean | null>;
    presentFailure(): void;
}>): Promise<void> {
    if (input.isCurrent?.() === false) return;
    try {
        const prepared = input.prepare ? await input.prepare() : true;
        if (input.isCurrent?.() === false) return;
        if (!prepared) {
            input.presentFailure();
            return;
        }
    } catch {
        if (input.isCurrent?.() === false) return;
        input.presentFailure();
        return;
    }
    input.dismiss();
    let succeeded: boolean | null = false;
    try {
        succeeded = await input.activate();
    } catch {
        succeeded = false;
    }
    if (succeeded === false) input.presentFailure();
}
