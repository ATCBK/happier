import * as React from 'react';
import { getAgentStaticModels } from '@happier-dev/agents';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';

import {
  SessionModelPicker,
  type SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import {
  buildSessionModelSelectedTriggerPresentation,
  hiddenModelVisibilityKeys,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';

type ProjectionGroups = NonNullable<
  ReturnType<typeof useProviderModelProjection>['data']
>['groups'];

const EMPTY_GROUPS: ProjectionGroups = [];

function ExactModelChoiceModal(
  props: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly {
      value: string;
      label: string;
      description?: string;
    }[];
    providerGroups: ProjectionGroups;
    providerProjectionAuthoritative: boolean;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys: ReadonlySet<string>;
    selected: ProviderBoundModelRef | null;
    effectiveLabel: string;
    experimentalConfirmation: SessionModelPickerExperimentalConfirmationController;
    onSelect: (selection: ProviderBoundModelRef | null) => void;
    onClose: () => void;
  }>,
) {
  return (
    <SessionModelPicker
      agentTargetKey={props.agentTargetKey}
      nativeModels={props.nativeModels}
      providerGroups={props.providerGroups}
      providerProjectionAuthoritative={props.providerProjectionAuthoritative}
      currentSelectionRecovery={props.currentSelectionRecovery}
      hiddenNativeModelKeys={props.hiddenNativeModelKeys}
      selected={props.selected}
      effectiveLabel={props.effectiveLabel}
      experimentalConfirmation={props.experimentalConfirmation}
      onSelect={(selection) => {
        props.onSelect(selection);
        props.onClose();
      }}
    />
  );
}

/**
 * One exact model choice for an Agent (native or a Provider source), outside a running Session: a
 * profile's preferred model, the Account default, a Run that cannot follow its Session. The row
 * reads `presentation`; `open` shows the same model picker the composer uses, in a card.
 */
export function useExactModelChoice(
  params: Readonly<{
    agentTargetKey: string | null;
    /** The Agent whose own models lead the picker; null offers Provider sources only. */
    agentId: string | null;
    machineId: string | null;
    serverId: string | null;
    selected: ProviderBoundModelRef | null;
    title: string;
    fallbackLabel: string;
    enabled?: boolean;
  }>,
) {
  const providersEnabled = useFeatureEnabled('providers', {
    scopeKind: 'spawn',
    serverId: params.serverId,
  });
  const enabled = params.enabled !== false;
  const providerSettings = useProviderSettingsForServer(params.serverId);
  const projection = useProviderModelProjection({
    enabled: providersEnabled && enabled,
    machineId: params.machineId,
    serverId: params.serverId,
    agentTargetKey: params.agentTargetKey,
    mode: 'picker',
    ...(params.selected ? { currentSelection: params.selected } : {}),
  });
  const confirmExperimentalModel = useConfirmExperimentalProviderModel({
    enabled: providersEnabled && enabled,
    machineId: params.machineId,
    serverId: params.serverId,
    agentTargetKey: params.agentTargetKey,
    refresh: projection.refresh,
  });
  const nativeModels = React.useMemo(() => {
    if (!params.agentId) return [];
    try {
      return getAgentStaticModels(params.agentId).map((model) => ({
        value: model.id,
        label: model.name || model.id,
        ...(model.description ? { description: model.description } : {}),
      }));
    } catch {
      return [];
    }
  }, [params.agentId]);
  const hiddenNativeModelKeys = React.useMemo(
    () =>
      hiddenModelVisibilityKeys(providerSettings, {
        providersFeatureEnabled: providersEnabled,
      }),
    [providersEnabled, providerSettings],
  );
  const providerGroups = providersEnabled
    ? (projection.data?.groups ?? EMPTY_GROUPS)
    : EMPTY_GROUPS;
  const currentSelectionRecovery = providersEnabled
    ? (projection.data?.currentSelectionRecovery ?? null)
    : null;
  const providerProjectionAuthoritative =
    providersEnabled && projection.status === 'success';
  const presentation = React.useMemo(
    () =>
      buildSessionModelSelectedTriggerPresentation({
        agentTargetKey: params.agentTargetKey ?? '',
        nativeModels,
        providerGroups,
        hiddenNativeModelKeys,
        providerProjectionAuthoritative,
        selected: params.selected,
        currentSelectionRecovery,
        fallbackLabel: params.selected?.modelId ?? params.fallbackLabel,
        fieldLabel: params.title,
      }),
    [
      currentSelectionRecovery,
      hiddenNativeModelKeys,
      nativeModels,
      params.agentTargetKey,
      params.fallbackLabel,
      params.selected,
      params.title,
      providerGroups,
      providerProjectionAuthoritative,
    ],
  );

  const open = React.useCallback(
    (onSelect: (selection: ProviderBoundModelRef | null) => void) => {
      if (!params.agentTargetKey) return;
      Modal.show({
        component: ExactModelChoiceModal,
        props: {
          agentTargetKey: params.agentTargetKey,
          nativeModels,
          providerGroups,
          providerProjectionAuthoritative,
          currentSelectionRecovery,
          hiddenNativeModelKeys,
          selected: params.selected,
          effectiveLabel: params.selected?.modelId ?? params.fallbackLabel,
          experimentalConfirmation: confirmExperimentalModel,
          onSelect,
        },
        chrome: {
          kind: 'card',
          title: params.title,
          dimensions: { size: 'lg' },
        },
        closeOnBackdrop: true,
      });
    },
    [
      confirmExperimentalModel,
      currentSelectionRecovery,
      hiddenNativeModelKeys,
      nativeModels,
      params.agentTargetKey,
      params.fallbackLabel,
      params.selected,
      params.title,
      providerGroups,
      providerProjectionAuthoritative,
    ],
  );

  return {
    presentation,
    open,
    loading: projection.loading,
    error: providersEnabled ? projection.error : null,
    refresh: projection.refresh,
  };
}
