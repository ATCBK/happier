import { t } from '@/text';

import type { WorkflowRunInputPresentation } from '../run/WorkflowRunComposer';

/**
 * Localized copy for the inputs of Happier's built-in workflows.
 *
 * Built-in definitions name their inputs with protocol keys (`request`, `maxRounds`), which are
 * the authored contract and never shown. Every surface that collects a built-in's inputs (the run
 * composer, the trigger popover) reads its labels here, so a built-in input reads the same
 * everywhere. Authored workflows name their own inputs and have no entry.
 */
export function resolveWorkflowBuiltinInputPresentation(workflowRef: string | null | undefined): WorkflowRunInputPresentation | undefined {
    switch (workflowRef) {
        case 'builtin:review-and-converge':
            return {
                engines: { title: t('workflows.builtins.reviewAndConverge.inputs.engines') },
                reviewSession: { title: t('workflows.builtins.reviewAndConverge.inputs.reviewSession') },
                maxRounds: { title: t('workflows.builtins.reviewAndConverge.rounds') },
                apply: { title: t('workflows.builtins.reviewAndConverge.apply'), optionLabels: {
                    fix: t('workflows.builtins.reviewAndConverge.verifyAndFix'),
                    report: t('workflows.builtins.reviewAndConverge.verifyOnly'),
                } },
            };
        case 'builtin:plan-with-a-panel':
            return {
                request: { title: t('workflows.builtins.planWithAPanel.inputs.request'),
                    placeholder: t('workflows.builtins.planWithAPanel.inputs.requestPlaceholder') },
                engines: { title: t('workflows.builtins.planWithAPanel.inputs.engines') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:fresh-opinions':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                synthesis: { title: t('workflows.builtins.patternInputs.synthesis') },
                synthesizer: { title: t('workflows.builtins.patternInputs.synthesizer') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:answer-and-review':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                answerer: { title: t('workflows.builtins.patternInputs.answerer') },
                reviewer: { title: t('workflows.builtins.patternInputs.reviewer') },
            };
        case 'builtin:debate':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                rounds: { title: t('workflows.builtins.patternInputs.rounds') },
                digestAuthor: { title: t('workflows.builtins.patternInputs.digestAuthor') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:open-a-pull-request':
            return {
                base: { title: t('workflows.builtins.openAPullRequest.inputs.base') },
                title: { title: t('workflows.builtins.openAPullRequest.inputs.title') },
                body: { title: t('workflows.builtins.openAPullRequest.inputs.body') },
                question: { title: t('workflows.builtins.openAPullRequest.inputs.question') },
            };
        default:
            return undefined;
    }
}
