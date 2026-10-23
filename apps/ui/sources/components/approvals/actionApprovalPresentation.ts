import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { describeApprovalActionFields, type ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveActionSummary, resolveActionTitle } from '@/text/actionTitles';
import { t } from '@/text';
import { getPreferredLanguage } from '@/text/i18n';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { readWidgetApprovalPresentationV1 } from '@happier-dev/protocol/widgets';
import { presentLocalServiceControlApproval, readLocalServiceControlSubject } from './localServiceControlApprovalPresentation';

export type ActionApprovalPresentationInput = Readonly<{
    actionId: string;
    actionArgs?: unknown;
    preview?: unknown;
    authoredTitle?: string | null;
    authoredSummary?: string | null;
    subject?: string | null;
    role?: RoleCatalogEntry | null;
    /** The target Machine's readable path form (home-relative), when the presenting app knows its home. */
    formatPath?: ((path: string) => string) | null;
}>;

/** Only the Account override Actions name an Account catalog Role. */
export function readActionApprovalRoleId(input: ActionApprovalPresentationInput): string | null {
    if (input.actionId !== 'roles.override.set' && input.actionId !== 'roles.override.reset') return null;
    const parsed = RoleActionInputSchemasV1[input.actionId].safeParse(input.actionArgs);
    return parsed.success ? parsed.data.roleId : null;
}

/** The existing Protocol reference projection owns subject identity, never a caller's id guess. */
export function readActionApprovalSubject(input: ActionApprovalPresentationInput): ApprovalActionReference | undefined {
    const serviceControl = readLocalServiceControlSubject(input);
    if (serviceControl) return serviceControl;
    const references = describeApprovalActionFields({ ...input, actionArgs: input.actionArgs }).rows.flatMap(row => row.kind === 'value'
        ? [...(row.reference ? [row.reference] : []), ...(row.entries?.flatMap(entry => entry.reference ? [entry.reference] : []) ?? [])]
        : []);
    // A workspace-sync request is titled by its Action; its controller machine and linked folders read in Details.
    if (input.actionId.startsWith('workspace.sync.')) return undefined;
    // The Home only routes the request: the thing acted on (a Machine, a Session) is the subject when there is one.
    return references.find(reference => reference.kind !== 'home') ?? references[0];
}

/** One UI copy boundary for confirmation, Inbox, page and preview; authored plugin copy stays authored. */
export function presentActionApproval(input: ActionApprovalPresentationInput): Readonly<{ title: string | null; summary: string | null; confirmLabel: string | null; destructive?: boolean }> {
    const serviceControl = presentLocalServiceControlApproval({ actionId: input.actionId, actionArgs: input.actionArgs, subject: input.subject });
    if (serviceControl) return serviceControl;
    const parsed = ActionIdSchema.safeParse(input.actionId);
    if (!parsed.success) return { title: input.authoredTitle?.trim() || null, summary: input.authoredSummary?.trim() || null, confirmLabel: null };
    const spec = getActionSpec(parsed.data);
    const role = input.role?.roleId === readActionApprovalRoleId(input) ? input.role : null;
    const roleKind = role ? role.source === 'built_in' ? t('roles.settings.sourceBuiltIn')
        : role.source === 'user' ? t('roles.settings.sourceYours')
        : role.source === 'shared' ? t('roles.settings.sourceShared') : t('roles.settings.groupPlugins') : null;
    const roleIdentity = role && roleKind ? { name: role.role.name, kind: roleKind } : undefined;
    const english = getPreferredLanguage() === 'en';
    const titleSource = roleIdentity || !english ? resolveActionTitle(spec.id, spec) : spec.title;
    const widgetPresentation = readWidgetApprovalPresentationV1(input.preview);
    const summarySource = buildApprovalPreviewSummary(spec, input.actionArgs, {
        ...(input.formatPath ? { formatPath: input.formatPath } : {}), ...(widgetPresentation ? { widgetPresentation } : {}),
    });
    const authoredSummary = input.authoredSummary?.trim();
    const distinctAuthoredSummary = authoredSummary && authoredSummary !== summarySource ? authoredSummary : null;
    const summary = distinctAuthoredSummary ? distinctAuthoredSummary
        : t('actionPresentation.summary', { actionId: spec.id,
            source: summarySource === `${spec.title}.` ? `${titleSource}.`
                : english ? summarySource : resolveActionSummary(spec.id, summarySource), subject: input.subject, role: roleIdentity });
    const visibleSummary = !distinctAuthoredSummary && summarySource === `${spec.title}.`
        && (summary === titleSource || summary === `${titleSource}.`) ? null : summary;
    // Backup authority follows the Action into both confirmation and Inbox, including authored previews.
    const disclosure = spec.id === 'relay.runtime.personal_home.backup' ? t('personalHome.settings.backupDisclosureBody') : null;
    const title = t('actionPresentation.title', { actionId: spec.id, source: titleSource,
        subject: roleIdentity ? `${roleIdentity.name} · ${roleIdentity.kind}` : input.subject });
    // The Action declares no confirm verb of its own: the button names the Action only when the title is about
    // its subject; a title that already is the Action's words gets the generic approval verb, never an echo.
    const confirmLabel = title === titleSource ? t('approvals.approve') : titleSource;
    // A danger effect the user is asked about by default is the Action's declaration of an irreversible effect.
    const irreversible = spec.sideEffectClass === 'danger' && spec.approvalPolicy?.uiConfirmation === 'policy';
    return {
        confirmLabel,
        title,
        summary: disclosure ? [visibleSummary, disclosure].filter(Boolean).join('\n\n') : visibleSummary,
        ...(irreversible ? { destructive: true } : {}),
    };
}
