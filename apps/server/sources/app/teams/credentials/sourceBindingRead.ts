import { TeamCredentialSourceBindingV1Schema, type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

const storedSourceBindingSchema = createStoredReadSchema(TeamCredentialSourceBindingV1Schema);

/** Stored rows can be corrupt; callers own their surface's unavailable projection.
 * Known identity fields remain validated; unknown stored fields are dropped.
 * Request inputs use the strict schema at their admission boundary. */
export function readTeamCredentialSourceBinding(value: string):
    | Readonly<{ success: true; data: TeamCredentialSourceBindingV1 }>
    | Readonly<{ success: false; reason: 'invalid_json' | 'invalid_binding' }> {
    try {
        const parsed = storedSourceBindingSchema.safeParse(JSON.parse(value));
        return parsed.success ? { success: true, data: parsed.data } : { success: false, reason: 'invalid_binding' };
    } catch {
        return { success: false, reason: 'invalid_json' };
    }
}
