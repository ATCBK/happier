import {
    describeHappierDropOutcome,
    describeHappierSettledDrop,
    type HappierDropEffect,
    type HappierDropOutcomeVocabulary,
    type HappierDropVerdict,
    type HappierReleaseOutcome,
} from '@happier-dev/plugin-ui/presentation';

import { PANE_DROP_UNCHANGED_CODES } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { SESSION_LIST_NO_TARGET_CODE } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { t } from '@/text';
import { useFailureExplainedByUnreachableHome } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import type { EntityDragDropSnapshot } from '../entityDragDropTypes';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { WIDGET_MOVE_SILENT_CODES } from '../widgetLayoutEntityDrop';

/**
 * Happier core's words for the ONE outcome presenter (`describeHappierDropOutcome`, plugin-ui): the
 * carried card, every docked keyboard preview, the polite status and the source row's lasting line
 * all describe a verdict through `describeEntityDropOutcome`, so no surface words an outcome twice.
 *
 * Targets declare their mark in the same portable preview as plugins.
 */

const isRelation = (effect: HappierDropEffect) => effect.actionId === 'session.reports_to.set';

/** "Already here": releasing changes nothing, so it is quiet, never a refusal. */
const UNCHANGED_CODES: ReadonlySet<string> = new Set([
    ...PANE_DROP_UNCHANGED_CODES,
    'no-change', 'same-position', 'board-no-change',
]);

function vocabulary(verdict?: HappierDropVerdict): HappierDropOutcomeVocabulary {
    return {
        pendingTitle: effect => isRelation(effect)
            ? t('entityDragDrop.preview.pendingPutUnder', { target: effect.preview.target })
            : effect.preview.verb,
        pendingDetail: t('entityDragDrop.preview.pendingDetail'),
        refusedTitle: t('entityDragDrop.preview.cantMoveHere'),
        refusedPreviewTitle: preview => {
            const target = preview.target;
            switch (preview.glyph) {
                case 'nest': return t('entityDragDrop.preview.cantPutUnder', { target });
                case 'above': return t('entityDragDrop.preview.cantMoveAbove', { target });
                case 'below': return t('entityDragDrop.preview.cantMoveBelow', { target });
                case 'move':
                case 'folder':
                case 'topLevel': return t('entityDragDrop.preview.cantMoveTo', { target });
                case 'copy': return t('entityDragDrop.preview.cantCopyTo', { target });
                case 'attach': return t('entityDragDrop.preview.cantAttachTo', { target });
                case 'upload': return t('entityDragDrop.preview.cantUploadTo', { target });
                case 'open':
                case 'tab': return t('entityDragDrop.preview.cantOpen', { target });
                case 'goTo': return t('entityDragDrop.preview.cantGoTo', { target });
                case 'split':
                case 'splitVertical': return t('entityDragDrop.preview.cantSplitHere');
                default: return t('entityDragDrop.preview.cantAddTo', { target });
            }
        },
        lateRefusalTitle: (effect, item) => isRelation(effect)
            ? item
                ? t('entityDragDrop.settled.refusedPutUnder', { item, target: effect.preview.target })
                : t('entityDragDrop.preview.cantPutUnder', { target: effect.preview.target })
            : t('entityDragDrop.settled.refused', { verb: effect.preview.verb }),
        unknownTitle: effect => t('entityDragDrop.settled.unknown', { verb: effect.preview.verb }),
        unknownDetail: resolveActionExecutionFailureMessage({ ok: false, errorCode: verdict?.outcome && verdict.outcome.status !== 'applied' ? verdict.outcome.reason.code : undefined },
            t('entityDragDrop.preview.unknownDetail'))!,
        unchangedCodes: UNCHANGED_CODES,
        unchangedTitle: t('entityDragDrop.pane.alreadyHere'),
        unchangedDetail: t('entityDragDrop.pane.leaveIt'),
        silentCodes: new Set([SESSION_LIST_NO_TARGET_CODE, ...WIDGET_MOVE_SILENT_CODES]),
    };
}

/** The release preview for the drag owner's verdict, in Happier's words. */
export function describeEntityDropOutcome(verdict: HappierDropVerdict, itemTitle: string | null = null): HappierReleaseOutcome | null {
    return describeHappierDropOutcome(verdict, vocabulary(verdict), itemTitle);
}

/** Reachability changes presentation only; the effect owner retains the dispatched result. */
export function useEntityDropOutcome(verdict: EntityDragDropSnapshot | null, itemTitle: string | null = null): HappierReleaseOutcome | null {
    const unavailable = useFailureExplainedByUnreachableHome(verdict?.phase === 'pending' && verdict.item ? [verdict.item.scope.serverId] : []);
    const outcome = verdict ? describeEntityDropOutcome(verdict, itemTitle) : null;
    return outcome?.tone === 'pending' && unavailable ? { ...outcome, tone: 'quiet',
        title: t('settingsPlugins.targetSelection.unreachableThisHome'), detail: t('entityDragDrop.preview.unknownDetail') } : outcome;
}

/** A dispatched effect its owner refused or could not confirm, as the source row keeps it. */
export function describeEntityDropSettled(verdict: HappierDropVerdict, itemTitle: string | null = null) {
    return describeHappierSettledDrop(verdict, vocabulary(verdict), itemTitle);
}
