import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import type { UsageCalendarExportInput } from '@happier-dev/protocol/usage/usageCalendarExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ProviderAccountSubscriptionMonthlyPriceV1Schema } from '@happier-dev/protocol/connect/accountSubscription';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { UsagePlanDisclosure } from './UsagePlanParts';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { exportUsageTextDocument } from '../../usageExportFile';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useUsageSelectorMachineId } from './useUsagePlans';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { UsagePlanAccount } from './usagePlansModel';

/** Save is an explicit local operation after the same authorized, selected-fact Action read. */
export function UsageCalendarExportButton(props: Readonly<{ input: UsageCalendarExportInput; serverId: string; testID: string }>) {
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed' | 'saved'>('idle');
  const pending = React.useRef<Readonly<{ cancel(): void; dispose(): void }> | null>(null);
  React.useEffect(() => () => { pending.current?.cancel(); pending.current?.dispose(); }, []);
  const save = async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    const retired = lifetime.onRetire(() => { controller.abort(); setState('idle'); });
    const request = { cancel: () => controller.abort(), dispose: () => retired.dispose() };
    pending.current = request;
    try {
      const result = await createFrontDoorActionExecute()('usage.calendar.export', props.input, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
      });
      if (controller.signal.aborted || !lifetime.isCurrent()) return;
      const file = result.ok ? UsageFileResultSchema.safeParse(result.result) : null;
      if (!file?.success || file.data.mediaType !== 'text/calendar') { setState('failed'); return; }
      const saved = await exportUsageTextDocument({ content: new TextDecoder().decode(decodeBase64(file.data.base64)),
        fileName: file.data.fileName, mimeType: file.data.mediaType, isCurrent: () => !controller.signal.aborted && lifetime.isCurrent() });
      if (!controller.signal.aborted && lifetime.isCurrent()) setState(saved ? 'saved' : 'failed');
    } catch { if (!controller.signal.aborted && lifetime.isCurrent()) setState('failed'); }
    finally { request.dispose(); if (pending.current === request) pending.current = null; }
  };
  return <View>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.calendarExport')}
      loading={state === 'pending'} disabled={state === 'pending'} onPress={() => { void save(); }} />
    {state === 'failed' ? <Text style={priceStyles.note} accessibilityRole="alert">{t('usage.board.plans.calendarFailed')}</Text> : null}
    {state === 'saved' ? <Text style={priceStyles.note}>{t('usage.board.plans.calendarSaved')}</Text> : null}
  </View>;
}

/** No browser destination is derived here: the admitted Connected Account descriptor owns it. */
export function UsageBillingButton(props: Readonly<{ account: UsagePlanAccount; serverId: string; testID: string }>) {
  const machineId = useUsageSelectorMachineId();
  const registry = useProjectedConnectedServicesRegistry();
  const destinationKnown = registry.entries.some(entry => entry.service?.pluginId === props.account.service.pluginId
    && entry.service.localId === props.account.service.localId && entry.projectedDescriptor?.billingUrl && entry.executable === true);
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed'>('idle');
  const pending = React.useRef<Readonly<{ cancel(): void; dispose(): void }> | null>(null);
  React.useEffect(() => () => { pending.current?.cancel(); pending.current?.dispose(); }, []);
  const open = async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!machineId || !destinationKnown || !lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    const retired = lifetime.onRetire(() => { controller.abort(); setState('idle'); });
    const request = { cancel: () => controller.abort(), dispose: () => retired.dispose() };
    pending.current = request;
    try {
      const result = await createFrontDoorActionExecute()('connectedServices.billing.open', { account: props.account.source.ref, machineId }, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
      });
      if (!controller.signal.aborted && lifetime.isCurrent()) setState(result.ok ? 'idle' : 'failed');
    } catch { if (!controller.signal.aborted && lifetime.isCurrent()) setState('failed'); }
    finally { request.dispose(); if (pending.current === request) pending.current = null; }
  };
  return <View>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.billingOpen')}
      loading={state === 'pending'} disabled={!machineId || !destinationKnown || state === 'pending'} onPress={() => { void open(); }} />
    {!machineId || !destinationKnown || state === 'failed' ? <Text style={priceStyles.note}>{t('usage.board.plans.billingUnavailable')}</Text> : null}
  </View>;
}

export type UsagePlanActionState = 'idle' | 'pending' | 'approval' | 'failed';
type UsagePlanWriteActionId = 'session.pending.resetStart.set' | 'session.pending.resetStart.cancel' | 'connectedServices.subscription.price.set';

/**
 * One approval-gated Plans write through the UI front door, under the captured Account lifetime: the
 * same call for binding a pending start to a reset and for cancelling it. An approval request leaves
 * the row waiting; nothing is applied locally.
 */
export function useUsagePlanAction(expectedServerId?: string): Readonly<{
  state: UsagePlanActionState;
  run(actionId: UsagePlanWriteActionId, input: unknown, onSettled: () => void): Promise<void>;
}> {
  const viewer = useActiveServerAccountScope();
  const scopeKey = JSON.stringify([viewer?.serverId ?? null, viewer?.accountId ?? null]);
  const [presentation, setPresentation] = React.useState<Readonly<{ scopeKey: string; state: UsagePlanActionState }>>({ scopeKey, state: 'idle' });
  const approvals = useActionApprovalContinuation({ scopeKey, serverId: viewer?.serverId ?? expectedServerId ?? '', onExecuted: () => {} });
  const pending = React.useRef<Readonly<{ cancel(): void; dispose(): void }> | null>(null);
  React.useEffect(() => () => { pending.current?.cancel(); pending.current?.dispose(); }, []);
  const state = presentation.scopeKey === scopeKey ? presentation.state : 'idle';
  const run = React.useCallback(async (actionId: UsagePlanWriteActionId, input: unknown, onSettled: () => void) => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const setState = (state: UsagePlanActionState) => setPresentation({ scopeKey, state });
    if (!lifetime?.isCurrent() || scopeKey !== JSON.stringify([lifetime.scope.serverId, lifetime.scope.accountId])
      || (expectedServerId !== undefined && lifetime.scope.serverId !== expectedServerId)) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    const retired = lifetime.onRetire(() => { controller.abort(); setState('idle'); });
    const request = { cancel: () => controller.abort(), dispose: () => retired.dispose() };
    pending.current = request;
    const current = () => !controller.signal.aborted && lifetime.isCurrent();
    const release = () => { request.dispose(); if (pending.current === request) pending.current = null; };
    let deferred = false;
    try {
      const result = await createFrontDoorActionExecute()(actionId, input, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
      });
      if (!current()) return;
      if (!result.ok) { setState('failed'); return; }
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
      if (approval.success) {
        deferred = true;
        setState('approval');
        approvals.requestApproval(createActionApprovalContinuation({ artifactId: approval.data.artifactId,
          actionId, scope: lifetime.scope, expectedInput: input, signal: controller.signal, refreshAfterExecution: false,
          onSucceeded: () => { if (current()) { setState('idle'); onSettled(); } release(); },
          onFailed: () => { if (current()) setState('failed'); release(); },
        }));
        return;
      }
      setState('idle');
      onSettled();
    } catch { if (current()) setState('failed'); }
    finally { if (!deferred) release(); }
  }, [expectedServerId, scopeKey, approvals.requestApproval]);
  return { state, run };
}

/** The entered price is personal metadata. Its Action owns Account-mode sealing and persistence. */
export function UsageSubscriptionPriceEditor(props: Readonly<{
  account: UsagePlanAccount; serverId: string; testID: string; onSettled(): void;
}>) {
  const viewer = useActiveServerAccountScope();
  const scopeKey = JSON.stringify([props.serverId, viewer?.accountId ?? null, props.account.key]);
  return <UsagePlanDisclosure title={t('usage.board.plans.monthlyPrice')} testID={props.testID}>
    <SubscriptionPriceFields key={scopeKey} {...props} />
  </UsagePlanDisclosure>;
}

function SubscriptionPriceFields(props: React.ComponentProps<typeof UsageSubscriptionPriceEditor>) {
  const entered = props.account.subscription?.enteredMonthlyPrice;
  const [amount, setAmount] = React.useState(entered ? String(entered.amount) : '');
  const [currency, setCurrency] = React.useState(entered?.currency ?? '');
  const { state, run } = useUsagePlanAction(props.serverId);
  const viewer = useActiveServerAccountScope();
  const price = ProviderAccountSubscriptionMonthlyPriceV1Schema.safeParse({
    amount: amount.trim() ? Number(amount) : NaN, currency: currency.trim().toUpperCase(), enteredAtMs: Date.now(),
  });
  const available = viewer?.serverId === props.serverId && state !== 'pending' && state !== 'approval';
  // One line: amount, currency, then Save (and Clear). The fields keep a field's width, never the row's.
  return <View style={priceStyles.root}>
    <View style={priceStyles.line}>
      <FieldItem label={t('usage.board.plans.monthlyPriceAmount')} style={priceStyles.amount}>
        <FieldTextInput testID={`${props.testID}.amount`} value={amount} onChangeText={setAmount}
          accessibilityLabel={t('usage.board.plans.monthlyPriceAmount')} keyboardType="decimal-pad" inputMode="decimal" />
      </FieldItem>
      <FieldItem label={t('usage.board.plans.monthlyPriceCurrency')} style={priceStyles.currency}>
        <FieldTextInput testID={`${props.testID}.currency`} value={currency} onChangeText={setCurrency}
          accessibilityLabel={t('usage.board.plans.monthlyPriceCurrency')} autoCapitalize="characters" />
      </FieldItem>
      <View style={priceStyles.actions}>
        <RoundButton size="small" display="secondary" testID={`${props.testID}.save`} title={t('common.save')}
          disabled={!available || !price.success} loading={state === 'pending'} action={async () => {
            if (!price.success || !available) return;
            return run('connectedServices.subscription.price.set', { account: props.account.source.ref,
              price: { amount: price.data.amount, currency: price.data.currency } }, props.onSettled);
          }} />
        {entered ? <RoundButton size="small" display="secondary" testID={`${props.testID}.clear`} title={t('usage.board.plans.monthlyPriceClear')}
          disabled={!available} action={() => run('connectedServices.subscription.price.set',
            { account: props.account.source.ref, price: null }, () => { setAmount(''); setCurrency(''); props.onSettled(); })} /> : null}
      </View>
    </View>
    <Text style={priceStyles.note}>{t('usage.board.plans.monthlyPriceNote')}</Text>
    {state === 'failed' ? <Text accessibilityRole="alert" style={priceStyles.note}>{t('common.saveError')}</Text> : null}
    {state === 'approval' ? <Text style={priceStyles.note}>{t('usage.board.plans.waitingApproval')}</Text> : null}
  </View>;
}

const priceStyles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s6 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: theme.space.s12 },
  amount: { width: 160 },
  currency: { width: 96 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, paddingBottom: theme.space.s2 },
  note: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
}));
