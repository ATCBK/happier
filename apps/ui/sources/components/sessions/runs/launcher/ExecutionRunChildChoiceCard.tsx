import * as React from 'react';
import type { ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * D9's ask, above the kept draft: the chosen Agent can't follow (or can't be shown to follow) this
 * Session's route, so the person picks its Account default or an exact model. Either choice starts
 * a fresh attempt with the same message; Cancel leaves the draft as written.
 */
export function ExecutionRunChildChoiceCard(
  props: Readonly<{
    choice: ExecutionRunChildChoiceV1;
    agentTitle: string;
    /** "<route> · <model>" of the Session, or null when it isn't known. */
    parentDetail: string | null;
    starting: boolean;
    onUseDefault: () => void;
    onChooseModel: () => void;
    onCancel: () => void;
  }>,
) {
  const agent = props.agentTitle;
  const reason =
    props.choice.parentRouteCompatibility === 'unverified'
      ? props.parentDetail
        ? t('runPage.childChoice.unverified', {
            agent,
            parent: props.parentDetail,
          })
        : t('runPage.childChoice.unverifiedUnknown', { agent })
      : props.parentDetail
        ? t('runPage.childChoice.incompatible', {
            agent,
            parent: props.parentDetail,
          })
        : t('runPage.childChoice.incompatibleUnknown', { agent });
  return (
    <SurfaceStateCard
      testID="execution-run-child-choice"
      kind="warning"
      layout="inline"
      title={t('runPage.childChoice.title', { agent })}
      reason={reason}
      action={{
        testID: 'execution-run-child-choice.default',
        label: t('runPage.childChoice.useDefault', { agent }),
        onPress: props.onUseDefault,
        busy: props.starting,
        disabled: props.starting,
      }}
      secondaryAction={{
        testID: 'execution-run-child-choice.model',
        label: t('runPage.childChoice.chooseModel'),
        onPress: props.onChooseModel,
        disabled: props.starting,
      }}
      note={t('runPage.childChoice.keptNote')}
      learnMore={{
        testID: 'execution-run-child-choice.cancel',
        label: t('common.cancel'),
        onPress: props.onCancel,
      }}
      accessibilitySemantics="status"
    />
  );
}
