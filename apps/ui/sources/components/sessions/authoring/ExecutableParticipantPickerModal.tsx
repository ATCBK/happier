import * as React from 'react';
import { ExecutableParticipantPicker as ControlledExecutableParticipantPicker } from '@happier-dev/plugin-ui/components';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import {
  executableParticipantOptionId,
  useExecutableParticipantSections,
} from '@/components/discussions/useExecutableParticipantSections';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

type Choice =
  | ExecutableParticipantSelectionV1
  | readonly ExecutableParticipantSelectionV1[];

export type ExecutableParticipantPickerRequest = Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  multiple: boolean;
  selected?: Choice;
  signal: AbortSignal;
}>;

function sameParticipant(
  left: ExecutableParticipantSelectionV1,
  right: ExecutableParticipantSelectionV1,
): boolean {
  const id = executableParticipantOptionId(left);
  return id !== null
    ? id === executableParticipantOptionId(right)
    : left === right;
}

/** Mounted only while a participant field's Browse is open; the sections read sessions and machines. */
function ExecutableParticipantPicker(
  props: CustomModalInjectedProps &
    Omit<ExecutableParticipantPickerRequest, 'signal'> &
    Readonly<{
      onResolve: (choice: Choice | null) => void;
    }>,
) {
  const { onResolve, multiple } = props;
  const [readinessSessionId, setReadinessSessionId] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<
    readonly ExecutableParticipantSelectionV1[]
  >(() =>
    props.selected === undefined
      ? []
      : Array.isArray(props.selected)
        ? props.selected
        : [props.selected as ExecutableParticipantSelectionV1],
  );
  const onChoose = React.useCallback(
    (selection: ExecutableParticipantSelectionV1) => {
      if (!multiple) {
        onResolve(selection);
        return;
      }
      setChosen((current) =>
        current.some((entry) => sameParticipant(entry, selection))
          ? current.filter((entry) => !sameParticipant(entry, selection))
          : [...current, selection],
      );
    },
    [multiple, onResolve],
  );
  const { sections } = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    enabled: true,
    readinessSessionId,
    onReadinessSessionChange: setReadinessSessionId,
    sessionsContext: t('workflows.start.participantSession'),
    onChoose,
  });
  const presentedSections = React.useMemo(() => sections.map(section => ({
    id: section.id,
    title: section.title,
    rightAccessory: section.rightAccessory,
    options: section.options.map(option => ({
      id: option.id, label: option.label, subtitle: option.subtitle,
      icon: option.icon, rightAccessory: option.rightAccessory,
      accessibilityLabel: option.accessibilityLabel, disabled: option.disabled, testID: option.testID,
      onHighlight: option.onHighlight, onPressIn: option.onPressIn,
    })),
  })), [sections]);
  const selectOption = React.useCallback((id: string) => {
    const option = sections.flatMap(section => section.options).find(entry => entry.id === id);
    option?.onSelect?.();
  }, [sections]);
  const chosenIds = React.useMemo(
    () =>
      new Set(
        chosen.flatMap((entry) => {
          const id = executableParticipantOptionId(entry);
          return id === null ? [] : [id];
        }),
      ),
    [chosen],
  );
  return (
    <CorePluginUiPresentationScope>
      <ControlledExecutableParticipantPicker
        testID="executable-participant-picker"
        sections={presentedSections}
        searchPlaceholder={t('workflows.start.participantSearch')}
        selection={
          multiple
            ? { kind: 'multiple', selectedIds: chosenIds }
            : {
                kind: 'single',
                selectedId: chosenIds.values().next().value ?? null,
              }
        }
        onSelect={selectOption}
        onRequestClose={() => onResolve(null)}
        doneLabel={t('workflows.start.participantDone')}
        canConfirm={chosen.length > 0}
        onDone={() => onResolve(chosen)}
      />
    </CorePluginUiPresentationScope>
  );
}

/**
 * The host picker behind a Workflow participant input (`agentParticipant`): the same sessions and
 * models a Discussion invite offers. Choosing never starts anything; the start owner admits the value.
 */
export function presentExecutableParticipantPicker(
  request: ExecutableParticipantPickerRequest,
): Promise<Choice | null> {
  return new Promise((resolve) => {
    let modalId = '';
    let settled = false;
    const settle = (choice: Choice | null) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', cancel);
      resolve(choice);
      if (modalId) Modal.hide(modalId);
    };
    const cancel = () => settle(null);
    if (request.signal.aborted) return cancel();
    request.signal.addEventListener('abort', cancel, { once: true });
    modalId = Modal.show({
      component: ExecutableParticipantPicker,
      props: {
        accountLifetime: request.accountLifetime,
        multiple: request.multiple,
        ...(request.selected === undefined
          ? {}
          : { selected: request.selected }),
        onResolve: settle,
      },
      onRequestClose: cancel,
      onHostUnmount: cancel,
      closeOnBackdrop: true,
      chrome: {
        kind: 'card',
        title: t('workflows.start.participantTitle'),
        // One fixed frame, like the other session pickers: the list inside is the scroll owner, so
        // rows never clip and the card keeps its height while a search narrows the results.
        scrollHost: 'body',
        bodyScroll: 'none',
        dimensions: {
          width: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
          maxHeightRatio: 0.7,
        },
        phonePresentation: 'sheet',
      },
    });
    if (!modalId) cancel();
  });
}
