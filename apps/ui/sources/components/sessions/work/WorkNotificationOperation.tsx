import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useHappierPageSection } from '@happier-dev/plugin-ui/presentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import {
  callWorkflowAction,
  type WorkflowActionExecute,
} from '@/sync/domains/workflows/callWorkflowAction';
import type { WorkflowTriggerWriteResult } from '@/sync/domains/workflows/workflowTriggerActions';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
  operation: {
    minWidth: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  button: { minHeight: 44, flexShrink: 1 },
  status: { color: theme.colors.text.secondary, fontSize: 14 },
  error: { color: theme.colors.state.danger.foreground, fontSize: 14 },
}));

type NotificationSetupReport = (needed: boolean) => void;
const NotificationSetupContext = React.createContext<NotificationSetupReport | null>(null);

/**
 * The notification rows of one Work section. When no delivery channel exists, that is one cause for
 * every row in it, so the section offers one setup action instead of one per row.
 */
export function WorkNotificationGroup(props: Readonly<{ sourceId: string; style?: StyleProp<ViewStyle>; children: React.ReactNode }>) {
  const [needsSetup, setNeedsSetup] = React.useState(false);
  const router = useRouter();
  // The setup action starts where the rows' text does: on the section's own row inset.
  const rowInsetPx = useHappierPageSection()?.rowInsetPx ?? 0;
  return (
    <NotificationSetupContext.Provider value={setNeedsSetup}>
      <View style={props.style}>
        {props.children}
        {needsSetup ? (
          <View style={[stylesheet.operation, { paddingHorizontal: rowInsetPx }]}>
            <RoundButton
              testID={`notify-setup:${props.sourceId}`}
              style={stylesheet.button}
              display="secondary"
              size="small"
              title={t('sessionWork.notify.setup')}
              titleNumberOfLines="complete"
              onPress={() => {
                setNeedsSetup(false);
                router.push('/settings/notifications');
              }}
            />
          </View>
        ) : null}
      </View>
    </NotificationSetupContext.Provider>
  );
}

/** One quiet presentation of the canonical trigger owner, shared by Session and Run details. */
export function WorkNotificationOperation(
  props: Readonly<{
    sourceId: string;
    testIDPrefix: string;
    title: string;
    sets: readonly WorkflowTriggerSetV1[];
    /** The trigger owner's read state: a loading row holds its place, a failed one offers nothing. */
    status: 'loading' | 'ready' | 'failed';
    machineId: string | null;
    match: (set: WorkflowTriggerSetV1) => string | null;
    add: () => Promise<WorkflowTriggerWriteResult>;
    remove: (
      triggerId: string,
      automationId: string,
    ) => Promise<WorkflowTriggerWriteResult>;
    execute?: WorkflowActionExecute;
  }>,
) {
  const [acknowledged, setAcknowledged] =
    React.useState<WorkflowTriggerSetV1 | null>(null);
  const [error, setError] = React.useState(false);
  const reportNeedsSetup = React.useContext(NotificationSetupContext);
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    setAcknowledged(null);
  }, [props.sets]);
  const sets = acknowledged
    ? [
        acknowledged,
        ...props.sets.filter(
          (set) => set.automationId !== acknowledged.automationId,
        ),
      ]
    : props.sets;
  const registered = sets.flatMap((set) => {
    const triggerId = props.match(set);
    return triggerId ? [{ triggerId, automationId: set.automationId }] : [];
  })[0];
  const register = async () => {
    setError(false);
    try {
      // Resolve on intent, never per-row mount. Only the existing delivery
      // owner decides whether push, webhook or plugin channels are configured.
      const configured = await callWorkflowAction({
        actionId: 'action.options.resolve',
        // Notify me is a workflow/agent Action, not a direct UI send.
        // Its declared options source remains available to the trigger UI.
        input: { optionsSourceId: 'notifications.channels.available' },
        context: props.machineId
          ? {
              externalActionTarget: {
                kind: 'machine',
                machineId: props.machineId,
              },
            }
          : undefined,
        execute: props.execute,
        parseResult: (value) => {
          const schema = getActionSpec('action.options.resolve').outputSchema;
          if (!schema) throw new Error('Missing channel options schema');
          const result: unknown = schema.parse(value);
          if (
            !result ||
            typeof result !== 'object' ||
            !('options' in result) ||
            !Array.isArray(result.options)
          ) {
            throw new Error('Invalid channel options');
          }
          return result.options.some(
            (option: unknown) =>
              option !== null &&
              typeof option === 'object' &&
              'value' in option &&
              typeof option.value === 'string' &&
              (!('disabled' in option) || option.disabled !== true),
          );
        },
      });
      reportNeedsSetup?.(!configured);
      if (!configured) return;
      setAcknowledged((await props.add()).set);
    } catch {
      setError(true);
    }
  };
  const cancel = async () => {
    if (!registered) return;
    setError(false);
    try {
      setAcknowledged(
        (await props.remove(registered.triggerId, registered.automationId)).set,
      );
    } catch {
      setError(true);
    }
  };
  // An armed row says a delivery path exists: a "set up" offer left over from an earlier refusal is stale.
  const armed = Boolean(registered);
  React.useEffect(() => {
    if (armed) reportNeedsSetup?.(false);
  }, [armed, reportNeedsSetup]);
  const ready = props.status === 'ready';
  const changeRegistration = async (value: boolean) => {
    if (pending || value === Boolean(registered) || (!registered && !ready)) return;
    setPending(true);
    try {
      if (value) await register();
      else await cancel();
    } finally {
      setPending(false);
    }
  };
  // A failed owner read offers nothing: never a disabled control that cannot succeed. While the
  // owner is still answering, the row's existence is known, so it holds its place with its switch
  // disabled (no shift when the answer lands). An armed or failed operation keeps its state.
  if (props.status === 'failed' && !registered && !error) return null;
  return <WorkNotificationOperationView sourceId={props.sourceId} testIDPrefix={props.testIDPrefix}
    title={props.title} armed={Boolean(registered)} pending={pending} disabled={pending || (!ready && !registered)}
    error={error} onChange={changeRegistration} />;
}

/** State-free shared row; Follow and authored Run Habits keep their own owners. */
export function WorkNotificationOperationView(props: Readonly<{
  sourceId: string;
  testIDPrefix: string;
  title: string;
  armed: boolean;
  pending: boolean;
  disabled: boolean;
  error: boolean;
  onChange: (value: boolean) => Promise<void>;
}>) {
  const id = (suffix: string) => `${props.testIDPrefix}${suffix}:${props.sourceId}`;
  return (
    <View>
      <Item
        testID={id(props.armed ? '-cancel' : '')}
        title={props.title}
        density="compact"
        subtitle={props.armed ? (
          <Text testID={id('-armed')} accessibilityLiveRegion="polite" style={stylesheet.status}>
            {t('sessionWork.notify.armed')}
          </Text>
        ) : undefined}
        disabled={props.disabled}
        loading={props.pending}
        showChevron={false}
        onPress={() => { void props.onChange(!props.armed); }}
        rightElementOutsidePressable
        rightElement={(
          <Switch
            testID={id('-switch')}
            accessibilityLabel={props.title}
            value={props.armed}
            disabled={props.disabled}
            onValueChange={(value) => { void props.onChange(value); }}
          />
        )}
      />
      {props.error ? (
        <Text
          testID={id('-error')}
          accessibilityLiveRegion="polite"
          style={stylesheet.error}
        >
          {t('sessionWork.notify.failed')}
        </Text>
      ) : null}
    </View>
  );
}
