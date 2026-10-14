import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import type {
  AgentInputExtraActionChip,
  AgentInputStatusBadge,
} from '@/components/sessions/agentInput/agentInputContracts';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { mcpServerRoute } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { McpServerMark } from '@/components/settings/mcpServers/identity/McpServerMark';
import { mcpServerStatus } from '@/components/settings/mcpServers/status/mcpServerStatus';
import { skillStatus } from '@/components/settings/skills/status/skillStatus';
import { useSkillPlaces } from '@/components/settings/skills/useSkillPlaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useReachRulesLookup } from '@/sync/store/useReachRulesCatalog';
import { t } from '@/text';

import {
  createCapabilitiesActionChip,
  SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO,
} from './createCapabilitiesActionChip';
import {
  SessionCapabilitiesContent,
  type SessionCapabilitiesChange,
} from './SessionCapabilitiesContent';
import {
  buildSessionCapabilitiesModel,
  type SessionCapabilitiesModel,
  type SessionCapabilitiesModelInput,
} from './sessionCapabilitiesModel';
import { useSessionCapabilityRestart } from './sessionCapabilityRestart';
import {
  useExistingSessionCapabilitiesPopover,
  useNewSessionCapabilitiesPopover,
  type NewSessionCapabilitiesDraft,
  type SessionCapabilitiesTarget,
} from './useSessionCapabilitiesPopover';

type Detail = Pick<
  SessionCapabilitiesModelInput,
  'rules' | 'mcpStatus' | 'skillStatus' | 'names'
>;
type ModelInput = Pick<
  SessionCapabilitiesModelInput,
  'view' | 'selection' | 'state' | 'readOnly' | 'change' | 'applyState'
>;
type Base = Omit<
  SessionCapabilitiesModelInput,
  keyof Detail | keyof ModelInput
>;

const NO_RULES: ReturnType<Detail['rules']> = [];
const NO_STATUSES: ReturnType<Detail['mcpStatus']> = [];
const NO_BASE: Base = {};
/**
 * The always-mounted chip needs no rules, statuses or names: its counts come from the preview alone.
 * The detail owners mount only in the open sheet, which reports back the one summary fact the closed
 * chip shows (its attention dot).
 */
const CLOSED_DETAIL: Detail = {
  rules: () => NO_RULES,
  mcpStatus: () => NO_STATUSES,
  skillStatus: () => NO_STATUSES,
  names: {
    agentName: (id) => id,
    machineName: (id) => id,
    projectName: (key) => key,
    folderLabel: (_machineId, root) => root,
  },
};

/**
 * The sheet's detail inputs, from their canonical owners: rules from the Account rows (P2), skill and MCP
 * statuses from P6/P7's status owners, names from the places owner.
 */
function useSessionCapabilitiesDetail(serverId: string | null) {
  const router = useRouter();
  const active = useActiveServerSnapshot(!serverId);
  const { binding } = useServerCredentialAccountScopeBinding(
    serverId ?? active.serverId,
  );
  const scope = binding?.scope ?? null;
  const { rules, mcpCatalog } = useReachRulesLookup(scope);
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  const library = useSkillsLibrary();
  const { names } = useSkillPlaces();
  const servers = React.useMemo(
    () =>
      new Map((mcpCatalog?.servers ?? []).map((entry) => [entry.id, entry])),
    [mcpCatalog],
  );
  const skills = React.useMemo(
    () => new Map(library.items.map((item) => [item.skillId, item])),
    [library.items],
  );
  const detail = React.useMemo<Detail>(
    () => ({
      rules,
      names,
      skillStatus: (skillId) => {
        const item = skills.get(skillId);
        return item ? skillStatus(item) : NO_STATUSES;
      },
      mcpStatus: (serverId) => {
        const entry = servers.get(serverId);
        if (!entry) return NO_STATUSES;
        const open = () => router.push(mcpServerRoute(serverId) as never);
        return mcpServerStatus({
          entry,
          signIn: null,
          tests: {},
          machines: [],
          savedSecretCatalog,
          fixes: {
            signIn: open,
            reconnect: open,
            grantAccess: open,
            addKey: open,
            howToFix: open,
            tryAgain: open,
          },
        });
      },
    }),
    [rules, names, skills, servers, savedSecretCatalog, router],
  );
  const renderMark = React.useCallback(
    (id: string) => (
      <McpServerMark
        transport={servers.get(id)?.transport ?? 'stdio'}
        size={20}
      />
    ),
    [servers],
  );
  return { detail, renderMark };
}

/** The open sheet: mounts the detail owners, projects the full model and renders the shared body. */
function SessionCapabilitiesSheet(
  props: Readonly<{
    serverId: string | null;
    base: Base;
    modelInput: ModelInput;
    onAttention: (attention: boolean) => void;
    onChange: SessionCapabilitiesChange;
    onRetry: () => void;
    machineName: string;
    maxHeight: number;
  }>,
) {
  const router = useRouter();
  const { detail, renderMark } = useSessionCapabilitiesDetail(props.serverId);
  const model = React.useMemo(
    () =>
      buildSessionCapabilitiesModel({
        ...props.base,
        ...detail,
        ...props.modelInput,
      }),
    [props.base, detail, props.modelInput],
  );
  const { onAttention } = props;
  React.useLayoutEffect(
    () => onAttention(model.attention),
    [onAttention, model.attention],
  );
  const onOpen = React.useCallback(
    (destination: 'skills' | 'mcp') =>
      router.push(
        (destination === 'skills'
          ? SETTINGS_ROUTES.skills
          : SETTINGS_ROUTES.mcp) as never,
      ),
    [router],
  );
  return (
    <SessionCapabilitiesContent
      model={model}
      onChange={props.onChange}
      onRetry={props.onRetry}
      onOpen={onOpen}
      renderMark={renderMark}
      machineName={props.machineName}
      maxHeight={props.maxHeight}
      testID="session-capabilities"
    />
  );
}

function useCapabilitiesChip(
  params: Readonly<{
    model: SessionCapabilitiesModel;
    modelInput: ModelInput;
    base: Base;
    stabilityKey: string;
    serverId: string | null;
    machineName: string;
    onChange: SessionCapabilitiesChange;
    onRetry: () => void;
    demandPreview: () => void;
  }>,
): AgentInputExtraActionChip {
  const { height } = useWindowDimensions();
  // Last known from the open sheet; the closed chip reads no statuses of its own.
  const [sheetAttention, setSheetAttention] = React.useState(false);
  const {
    model,
    modelInput,
    base,
    stabilityKey,
    serverId,
    machineName,
    onChange,
    onRetry,
    demandPreview,
  } = params;
  // Unknown is never zero: until the first preview the chip names what it holds, not "0 skills".
  const label = modelInput.view ? model.chipLabel : `${t('capabilities.skills.title')} · MCP`;
  const attention = model.attention || sheetAttention;
  return React.useMemo(
    () =>
      createCapabilitiesActionChip({
        label,
        attention,
        stabilityKey,
        onIntent: demandPreview,
        maxHeightCap: Math.round(
          height * SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO,
        ),
        popoverContent: ({ maxHeight }) => (
          <SessionCapabilitiesSheet
            serverId={serverId}
            base={base}
            modelInput={modelInput}
            onAttention={setSheetAttention}
            onChange={onChange}
            onRetry={onRetry}
            machineName={machineName}
            maxHeight={maxHeight}
          />
        ),
      }),
    [
      label,
      attention,
      modelInput,
      base,
      stabilityKey,
      serverId,
      machineName,
      onChange,
      onRetry,
      demandPreview,
      height,
    ],
  );
}

/**
 * The composer chip for a new-session draft, a workflow default or step override, and a trigger: "This
 * session gets" edits only the draft (P2 `useNewSessionCapabilities`); nothing is written until launch.
 */
export function useNewSessionCapabilitiesChip(
  params: Readonly<{
    draft: NewSessionCapabilitiesDraft;
    machineName: string;
  }>,
): Readonly<{
  chip: AgentInputExtraActionChip;
  model: SessionCapabilitiesModel;
}> {
  const popover = useNewSessionCapabilitiesPopover(params.draft, CLOSED_DETAIL);
  const { setItem, refresh } = popover;
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => setItem(change.kind, change.id, change.state),
    [setItem],
  );
  const onRetry = React.useCallback(() => {
    void refresh();
  }, [refresh]);
  const draft = params.draft;
  const stabilityKey = `draft:${draft.machineId ?? ''}:${draft.directory}:${draft.agentId}:${draft.targetServerId ?? ''}`;
  const chip = useCapabilitiesChip({
    model: popover.model,
    modelInput: popover.modelInput,
    base: NO_BASE,
    stabilityKey,
    serverId: draft.targetServerId ?? null,
    machineName: params.machineName,
    onChange,
    onRetry,
    demandPreview: popover.demandPreview,
  });
  return { chip, model: popover.model };
}

/**
 * The composer chip and the one apply line for an existing session: P2's session owner writes through
 * `session.capabilities.set` (optimistic, rolled back on failure, Undo resends the previous override).
 */
export function useExistingSessionCapabilitiesChip(
  params: Readonly<{
    target: Extract<SessionCapabilitiesTarget, { kind: 'session' }>;
    machineName: string;
    machineOnline: boolean;
    /** No turn running and no approval waiting: the D34 Restart may run. */
    turnSettled: boolean;
    stop: () => Promise<boolean>;
    resume: () => Promise<boolean>;
  }>,
): Readonly<{
  chip: AgentInputExtraActionChip;
  model: SessionCapabilitiesModel;
  applyBadge: AgentInputStatusBadge | null;
  undoLast: () => Promise<unknown>;
}> {
  const { machineName, machineOnline, turnSettled } = params;
  const base = React.useMemo<Base>(
    () => ({ machineName, machineOnline, turnSettled }),
    [machineName, machineOnline, turnSettled],
  );
  const input = React.useMemo(() => ({ ...CLOSED_DETAIL, ...base }), [base]);
  const popover = useExistingSessionCapabilitiesPopover(params.target, input);
  const { setItem, refresh } = popover;
  const sessionId = params.target.sessionId;
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => {
      const result = await setItem(change.kind, change.id, change.state);
      // P2 already rolled the row back; say so once on the app's notice owner.
      if (!result.ok && result.message !== 'read_only') {
        publishPresentationNotice({
          key: `session-capabilities:${sessionId}`,
          message: t('capabilities.control.changeFailed'),
          severity: 'error',
        });
      }
      return result;
    },
    [setItem, sessionId],
  );
  const onRetry = React.useCallback(() => {
    void refresh();
  }, [refresh]);
  const chip = useCapabilitiesChip({
    model: popover.model,
    modelInput: popover.modelInput,
    base,
    stabilityKey: `session:${sessionId}`,
    serverId: params.target.serverId,
    machineName,
    onChange,
    onRetry,
    demandPreview: popover.demandPreview,
  });
  const { badge } = useSessionCapabilityRestart({
    notice: popover.model.applyNotice,
    stop: params.stop,
    resume: params.resume,
  });
  return {
    chip,
    model: popover.model,
    applyBadge: badge,
    undoLast: popover.undoLast,
  };
}
