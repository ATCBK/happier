import { normalizeExecutableParticipantSelectionV1, type ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { buildSessionReadinessViewModel } from '@/components/sessions/model/sessionReadinessViewModel';
export { buildExecutableModelParticipantSelectionFromAuthoringDraft } from './draft/sessionAuthoringDraftAdapters';

export type ExecutableParticipantPickerOption = Readonly<{
    value: ExecutableParticipantSelectionV1;
    label: string;
}> & ReturnType<typeof buildSessionReadinessViewModel>;

/** The demanded picker supplies existing inventories and setup facts; this projection never probes or starts. */
export function buildExecutableParticipantPickerOption(input: Readonly<{
    selection: unknown;
    label: string;
    readiness: Parameters<typeof buildSessionReadinessViewModel>[0];
}>): ExecutableParticipantPickerOption | null {
    const value = normalizeExecutableParticipantSelectionV1(input.selection);
    return value ? { value, label: input.label, ...buildSessionReadinessViewModel(input.readiness) } : null;
}
