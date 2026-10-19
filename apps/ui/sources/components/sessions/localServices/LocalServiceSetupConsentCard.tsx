import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
  DEFAULT_PROJECT_SETUP_SCOPE,
  ProjectSetupReviewFacts,
  ProjectSetupScopeChoice,
  projectSetupRunLabel,
  type ProjectSetupScope,
} from '@/components/projects/projectSetup/ProjectSetupReview';
import { ApprovalDecisionFooter } from '@/components/tools/shell/approvals/ApprovalDecisionFooter';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * A Service Start/Restart waiting on its Project's setup: the same exact-effect facts and the same
 * This time / Until it changes choice the Scripts setup review offers, drawn through the approval
 * anatomy this surface's other review uses. It decides nothing itself; its owner applies the choice.
 */
export const LocalServiceSetupConsentCard = React.memo(function LocalServiceSetupConsentCard(
  props: Readonly<{
    testID: string;
    machineName: string;
    sharedRunAs: string | null;
    reviewedEffect: unknown;
    /** The scope a previous decision asked for, when this review is a re-ask. */
    initialScope?: ProjectSetupScope;
    effectChanged: boolean;
    deciding: boolean;
    /** Stop was requested for the held setup; it leaves only when it actually ends. */
    stopping: boolean;
    onDecide: (scope: ProjectSetupScope) => void;
    onNotNow: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [scope, setScope] = React.useState<ProjectSetupScope>(props.initialScope ?? DEFAULT_PROJECT_SETUP_SCOPE);
  return (
    <ApprovalPromptChrome
      testID={props.testID}
      title={t('projects.authoring.sessionAsk', { machine: props.machineName })}
      subtitle={props.effectChanged ? t('projects.authoring.effectChanged') : null}
      tone={props.effectChanged ? 'attention' : 'neutral'}
      footer={
        props.stopping ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }} testID={`${props.testID}.stopping`}>
            {t('projects.scripts.run.stopping')}
          </Text>
        ) : (
          <ApprovalDecisionFooter
            testIDPrefix={props.testID}
            isDeciding={props.deciding}
            approveLabel={scope === 'skip' ? t('common.skip') : projectSetupRunLabel(props.machineName, props.sharedRunAs)}
            rejectLabel={t('projects.scripts.setup.notNow')}
            onApprove={() => props.onDecide(scope)}
            onReject={props.onNotNow}
          />
        )
      }
    >
      <ProjectSetupReviewFacts
        testID={props.testID}
        reviewedEffect={props.reviewedEffect}
        machineName={props.machineName}
        sharedRunAs={props.sharedRunAs}
      />
      <ProjectSetupScopeChoice testID={props.testID} scope={scope} onChange={setScope} />
    </ApprovalPromptChrome>
  );
});
