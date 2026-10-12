import * as React from 'react';
import type { ReactElement } from 'react';
import { Avatar, DiffStat, Icon, Row, Stack, Text, usePluginTranslation, type TextTone } from '@happier-dev/plugin-ui';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { TriageStatusRow } from '@happier-dev/triage-sources/ui';

type CheckState = NonNullable<TriagePullRequestStatusV1['checks']>['rows'][number]['state'];
const CHECK_TONE = { passed: 'success', failed: 'danger', pending: 'warning', neutral: 'secondary', unknown: 'secondary' } as const satisfies Record<CheckState, TextTone>;

/** PP's detail rows: existing text, icons and avatars, with no new pane or card. */
export function PullRequestStatus(props: Readonly<{ status: TriagePullRequestStatusV1 }>): ReactElement {
    const text = usePluginTranslation();
    const { checks, review, merge, branch } = props.status;
    const activeChecks = checks?.rows.filter((row) => row.state !== 'passed') ?? [];
    const passingChecks = checks?.rows.filter((row) => row.state === 'passed') ?? [];
    const visibleChecks = activeChecks.length > 0 ? activeChecks : passingChecks.slice(0, 1);
    const otherPassing = passingChecks.length - (activeChecks.length > 0 ? 0 : visibleChecks.length);
    const checkLabel = (state: CheckState) => state === 'unknown'
        ? text('plugins.triage.sessionLinks.fact.unknown', 'Unknown')
        : text(`plugins.triage.sessionLinks.status.${state}`, { passed: 'Passed', failed: 'Failed', pending: 'Pending', neutral: 'Neutral' }[state]);
    const reviewerVerb = (verb: NonNullable<TriagePullRequestStatusV1['review']>['reviewers'][number]['verb']) => {
        switch (verb) {
            case 'approved': return text('plugins.triage.sessionLinks.approved', 'Approved');
            case 'changesRequested': return text('plugins.triage.sessionLinks.status.requestedChanges', 'requested changes');
            case 'commented': return text('plugins.triage.sessionLinks.status.commented', 'commented');
            case 'dismissed': return text('plugins.triage.sessionLinks.status.dismissed', 'dismissed');
            case 'pending': return text('plugins.triage.sessionLinks.status.pending', 'Pending');
        }
    };
    const mergeLabel = merge?.state === 'mergeable' ? text('plugins.triage.sessionLinks.status.mergeable', 'Ready to merge')
        : merge?.state === 'blocked' ? text('plugins.triage.sessionLinks.status.blocked', 'Blocked')
            : merge?.state === 'conflicts' ? text('plugins.triage.sessionLinks.status.conflicts', 'Conflicts')
                : text('plugins.triage.sessionLinks.fact.unknown', 'Unknown');
    return <Stack gap="medium">
        {checks === null ? null : <Stack gap="xsmall">
            <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.status.checks', 'Checks')} />
            {visibleChecks.map((check) => <TriageStatusRow key={check.id} presentation="compact" grow
                name={check.name} status={checkLabel(check.state)} tone={CHECK_TONE[check.state]}
                leading={<Icon name={check.state === 'passed' ? 'check' : check.state === 'neutral' || check.state === 'unknown' ? 'info' : 'warning'} size="small" tone={CHECK_TONE[check.state]} accessibilityLabel={checkLabel(check.state)} />} />)}
            {checks.state === 'none' ? <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.status.none', 'No checks')} /> : null}
            {otherPassing > 0 ? <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.status.otherPassing', '{count} other passing', { count: otherPassing })} /> : null}
            {checks.rows.length === 0 && checks.state !== 'none' ? <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.fact.unknown', 'Unknown')} /> : null}
        </Stack>}
        {review === null ? null : <Stack gap="xsmall">
            <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.fact.review', 'Review')} />
            {review.reviewers.length === 0 ? <TriageStatusRow presentation="summary" nameVariant="micro" nameTone="secondary" name={review.decision === 'approved'
                ? text('plugins.triage.sessionLinks.approved', 'Approved') : review.decision === 'changesRequested'
                    ? text('plugins.triage.sessionLinks.changesRequested', 'Changes requested') : review.decision === 'reviewRequired'
                        ? text('plugins.triage.sessionLinks.reviewRequired', 'Review required') : text('plugins.triage.sessionLinks.fact.unknown', 'Unknown')} /> : null}
            {review.reviewers.map((reviewer, index) => <TriageStatusRow key={`${reviewer.name}:${index}`} presentation="compact"
                name={reviewer.name} status={reviewerVerb(reviewer.verb)}
                tone={reviewer.verb === 'changesRequested' ? 'warning' : reviewer.verb === 'approved' ? 'success' : 'secondary'}
                leading={<Avatar name={reviewer.name} size="small" />} />)}
        </Stack>}
        {merge === null ? null : <Stack gap="xsmall">
            <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.status.merge', 'Merge')} />
            <TriageStatusRow presentation="summary" nameVariant="micro"
                nameTone={merge.state === 'mergeable' ? 'success' : merge.state === 'unknown' ? 'secondary' : 'warning'} name={merge.blocker ?? mergeLabel} />
        </Stack>}
        {branch === null ? null : <Stack gap="xsmall">
            <Text variant="micro" tone="secondary" value={text('plugins.triage.sessionLinks.status.branch', 'Branch')} />
            <Row gap="xsmall" align="center" wrap>
                <Text variant="code" value={branch.head} /><Text variant="micro" tone="secondary" value="→" /><Text variant="code" value={branch.base} />
                <DiffStat added={branch.additions ?? 0} removed={branch.deletions ?? 0} />
            </Row>
        </Stack>}
    </Stack>;
}
