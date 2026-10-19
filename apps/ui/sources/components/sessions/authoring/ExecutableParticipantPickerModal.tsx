import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import {
  executableParticipantOptionId,
  useExecutableParticipantSections,
} from '@/components/discussions/useExecutableParticipantSections';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  SelectionList,
  type SelectionListStep,
} from '@/components/ui/selectionList';
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
  const sections = useExecutableParticipantSections({
    accountLifetime: props.accountLifetime,
    enabled: true,
    sessionSubtitle: t('workflows.start.participantSession'),
    onChoose,
  });
  const rootStep = React.useMemo<SelectionListStep>(
    () => ({
      id: 'executable-participant-picker',
      inputPlaceholder: t('workflows.start.participantSearch'),
      sections,
    }),
    [sections],
  );
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
    <View testID="executable-participant-picker" style={styles.body}>
      <SelectionList
        rootStep={rootStep}
        heightBehavior="content"
        autoFocusInputOnWeb
        selection={
          multiple
            ? { kind: 'multiple', selectedIds: chosenIds }
            : {
                kind: 'single',
                selectedId: chosenIds.values().next().value ?? null,
              }
        }
        onSelect={() => undefined}
        onRequestClose={() => onResolve(null)}
      />
      {multiple ? (
        <View style={styles.footer}>
          <RoundButton
            testID="executable-participant-picker-done"
            size="normal"
            title={t('workflows.start.participantDone')}
            disabled={chosen.length === 0}
            onPress={() => onResolve(chosen)}
          />
        </View>
      ) : null}
    </View>
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
        scrollHost: 'bounded',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default },
        phonePresentation: 'sheet',
      },
    });
    if (!modalId) cancel();
  });
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12, flexShrink: 1 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end' },
}));
