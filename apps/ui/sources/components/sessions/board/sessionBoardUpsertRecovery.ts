import { SessionBoardItemUpsertInputV1Schema, type SessionBoardItemUpsertInputV1 } from '@happier-dev/protocol/sessions/board/actions';
import { SessionSurfaceItemV1Schema, SessionSurfaceItemV1StoredSchema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';

/**
 * An equal-looking pre-request row is not proof that an acknowledgement-lost
 * upsert committed. Every Board upsert advances the item revision, so the
 * canonical refreshed row proves the exact intent only when both its strict
 * semantic content and its revision differ from the submitted CAS operand.
 */
export function isSessionBoardUpsertIntentCommitted(input: Readonly<{
    intent: SessionBoardItemUpsertInputV1;
    revision: string | null;
    item: SessionSurfaceItemV1 | null;
}>): boolean {
    if (input.revision === null || input.revision === input.intent.expectedItemRevision || input.item === null) {
        return false;
    }
    const intent = SessionBoardItemUpsertInputV1Schema.safeParse(input.intent);
    const observed = SessionSurfaceItemV1StoredSchema.safeParse(input.item);
    if (!intent.success || !('item' in intent.data) || !observed.success) return false;
    const submitted = SessionSurfaceItemV1Schema.safeParse(intent.data.item);
    if (!submitted.success) return false;
    // Creation uses the Action schema's canonical destination transform. Both
    // writers replace any authored destination on updates with the stored creation
    // destination, so reconciliation uses that same authoritative observed value.
    const destination = intent.data.expectedItemRevision === null
        ? intent.data.destination
        : observed.data.destination;
    const expected = SessionSurfaceItemV1Schema.safeParse({ ...submitted.data, destination });
    // Stored-read transforms may insert a retained destination after other fields.
    // Reparse both semantic bodies through the same strict owner before comparing.
    const canonicalObserved = SessionSurfaceItemV1Schema.safeParse(observed.data);
    return expected.success && canonicalObserved.success
        && JSON.stringify(canonicalObserved.data) === JSON.stringify(expected.data);
}
