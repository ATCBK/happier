import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import { resolveExecutionRunSelectionLabel } from '@/components/sessions/runs/resolveExecutionRunSelectionLabel';
import type { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { t } from '@/text';

/**
 * The launcher's route chip (RT4, D9): a new Run follows the session unless the draft carries its
 * own choice. `inheritDetail` is what following the session means right now ("<route> · <model>"),
 * read from the parent's applied route; it is null when that is not known, never guessed.
 */
export function resolveExecutionRunRouteChoice(input: Readonly<{
    /** The draft has no model or route of its own and targets the parent's Agent. */
    inherits: boolean;
    inheritedSelection: ProviderBoundModelRef | null;
    inheritedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    inheritedRoutePresentation: ReturnType<typeof resolveSessionRoutePresentation> | null;
    /** The parent model's catalog title, when the caller knows one; `inheritDetail` says it instead of the id. */
    inheritedModelLabel?: string | null;
}>): Readonly<{ label: string; inheritDetail: string | null }> {
    const applied = input.inheritedRoutePresentation?.applied ?? null;
    const source = applied && applied.kind !== 'unknown' ? applied.sourceLabel : null;
    const teamModel = input.inheritedTeamCredentialModel;
    const model = teamModel?.modelId ?? input.inheritedModelLabel ?? input.inheritedSelection?.modelId ?? null;
    const inheritDetail = [source, model].filter((part): part is string => Boolean(part)).join(' · ') || null;
    if (!input.inherits) return { label: t('runPage.menu.selectionExplicit'), inheritDetail };
    // The same words the started Run's header uses, from the same label owner and model title.
    const label = teamModel || input.inheritedSelection
        ? resolveExecutionRunSelectionLabel(
            teamModel ? { source: 'inherited', teamCredentialModel: teamModel }
                : { source: 'inherited', modelSelection: input.inheritedSelection! },
            (connectionId) => applied?.kind === 'provider' && applied.connectionId === connectionId ? applied.sourceLabel : null,
            source,
            () => input.inheritedModelLabel ?? null,
        )
        : null;
    return { label: label ?? t('runPage.menu.selectionInherited'), inheritDetail };
}
