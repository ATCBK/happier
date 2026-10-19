import { PluginInstallationReviewSchema } from '@happier-dev/protocol/marketplace/internal';
import {
  describePluginInstallationReviewFacts,
  listPluginInstallationReviewFactSections,
} from '@/components/settings/plugins/model/pluginInstallationReviewFacts';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';

type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number];

/** Protocol's `describePluginInstallApprovalDisclosure` row: its `value` is the exact evaluated review. */
const PLUGIN_INSTALL_REVIEW_ROW_PATH =
  'preview.pluginInstall.pendingReview.review';

function readReview(row: ApprovalFieldRow) {
  if (row.kind !== 'value' || row.path !== PLUGIN_INSTALL_REVIEW_ROW_PATH)
    return null;
  try {
    const parsed = PluginInstallationReviewSchema.safeParse(
      JSON.parse(row.value),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A plugin-install approval reads as the same install-and-trust facts the Settings install review
 * shows (one presentation owner), one row per section. The evaluated structure itself stays one
 * disclosure away: every raw value moves to Technical details, keyed by where it sits.
 */
export function presentPluginInstallApprovalRows(
  rows: readonly ApprovalFieldRow[],
): readonly ApprovalFieldRow[] {
  if (
    !rows.some(
      (row) =>
        row.kind === 'value' && row.path === PLUGIN_INSTALL_REVIEW_ROW_PATH,
    )
  )
    return rows;
  return rows.flatMap((row): ApprovalFieldRow[] => {
    const review = readReview(row);
    if (!review || row.kind !== 'value') return [row];
    const sections = listPluginInstallationReviewFactSections(
      describePluginInstallationReviewFacts(review),
    );
    return [
      ...sections.map((section): ApprovalFieldRow => ({
        kind: 'value',
        path: `${row.path}#${section.id}`,
        title: section.title,
        value: section.lines.join('\n'),
      })),
      {
        ...row,
        title: review.displayName,
        technical: true,
        entries: row.entries?.map((entry) =>
          entry.value === null ? entry : { ...entry, technical: true as const },
        ),
      },
    ];
  });
}
