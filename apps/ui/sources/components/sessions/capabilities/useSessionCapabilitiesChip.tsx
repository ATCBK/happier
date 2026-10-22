import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { getAgentCore, isBundledAgentId, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { Message } from '@happier-dev/session-core/messages';

import type { CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
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
import {
  findMcpSignInGrant,
  mcpSignInFact,
  mcpSignInGrantView,
} from '@/components/settings/mcpServers/signIn/mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from '@/components/settings/mcpServers/signIn/useMcpSignInGrantDiagnostics';
import { useMcpServerSignIn } from '@/components/settings/mcpServers/signIn/useMcpServerSignIn';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { mcpServerStatus } from '@/components/settings/mcpServers/status/mcpServerStatus';
import { skillStatus } from '@/components/settings/skills/status/skillStatus';
import { useSkillPlaces } from '@/components/settings/skills/useSkillPlaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import { useSkillComposerSource } from '@/sync/domains/skills/useSkillComposerSource';
import type { SkillComposerSource } from '@/sync/domains/skills/skillComposerGroups';
import { skillHref } from '@/components/settings/skills/skillsCollectionModel';
import { useReachRulesLookup } from '@/sync/store/useReachRulesCatalog';
import { t } from '@/text';

import {
  createCapabilitiesActionChip,
  SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO,
} from './createCapabilitiesActionChip';
import {
  SessionCapabilitiesContent,
  type SessionCapabilitiesChange,
  type SessionCapabilitiesUndo,
} from './SessionCapabilitiesContent';
import {
  buildSessionCapabilitiesModel,
  type SessionCapabilitiesLastKnown,
  type SessionCapabilitiesModel,
  type SessionCapabilitiesModelInput,
} from './sessionCapabilitiesModel';
import { useSessionCapabilitiesOpenRequest } from './sessionCapabilitiesRoute';
import { useSessionCapabilityRestart } from './sessionCapabilityRestart';
import {
  useExistingSessionCapabilitiesPopover,
  useNewSessionCapabilitiesPopover,
  type NewSessionCapabilitiesDraft,
  type SessionCapabilitiesTarget,
} from './useSessionCapabilitiesPopover';

type Detail = Pick<
  SessionCapabilitiesModelInput,
  'rules' | 'mcpStatus' | 'skillStatus' | 'names' | 'context' | 'nativeSkills' | 'cost'
>;
export type SheetTarget = Readonly<{ sessionId?: string; metadata?: unknown;
  draft?: Pick<NewSessionCapabilitiesDraft, 'machineId' | 'directory' | 'agentId' | 'projectKey'> }>;
const EMPTY_MESSAGES: Readonly<Record<string, Message>> = Object.freeze({});
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
/**
 * The always-mounted chip needs no rules, statuses or names: its counts come from the preview alone.
 * The detail owners mount only in the open sheet, which reports back the one summary fact the closed
 * chip shows (its attention dot).
 */
export const CLOSED_DETAIL: Detail = {
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
export function useSessionCapabilitiesDetail(
  serverId: string | null,
  machineOnline: boolean | null,
  onFactsChanged: (factsKey: string) => void,
  target: SheetTarget,
  modelInput: ModelInput,
  machineName: string,
  /** The cost facts the sheet last knew: shown while the Account rows they come from are read again. */
  lastKnownCosts?: SessionCapabilitiesLastKnown['costs'],
) {
  const router = useRouter();
  const active = useActiveServerSnapshot(!serverId);
  const { binding } = useServerCredentialAccountScopeBinding(
    serverId ?? active.serverId,
  );
  const scope = binding?.scope ?? null;
  const { rules, skillRules, mcpCatalog } = useReachRulesLookup(scope);
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  // The Account's sign-in grants (P7's one reading of a grant): a row says "Sign-in expired" or
  // "Sign in" with its fix, as the server page does when no attempt is running.
  const grants = getStorage()((state) => areServerAccountScopesEqual(scope, state.profileScope) ? state.profile.connectedAccountsV4 : null);
  const reach = useReachMachines();
  const parsedMetadata = React.useMemo(() => MetadataSchema.safeParse(target.metadata), [target.metadata]);
  const metadata = parsedMetadata.success ? parsedMetadata.data : null;
  const nativeCatalogInput = metadata ? Reflect.get(metadata, 'sessionSkillCatalogV1') : undefined;
  const machineId = target.draft?.machineId ?? metadata?.machineId ?? null;
  const machine = areServerAccountScopesEqual(scope, reach.scope) ? reach.machines.find(row => row.machineId === machineId) : null;
  const agentId = target.draft?.agentId ?? (metadata ? resolveAgentIdFromSessionMetadata(metadata) : null);
  const diagnosticMachine = machineId;
  const diagnostics = useMcpSignInGrantDiagnostics(grants, scope, diagnosticMachine);
  const library = useSkillsLibrary(scope);
  // The open detail leaf observes the actual Account inputs; callback identity is not a fact.
  const factsKey = JSON.stringify([scope?.serverId, scope?.accountId, skillRules, mcpCatalog, machineId, agentId,
    metadata?.path, metadata?.workspaceId, metadata?.projectId, modelInput.selection,
    library.items.map(item => [item.skillId, item.revision])]);
  const observedFacts = React.useRef(factsKey);
  const factsChanged = React.useRef(onFactsChanged);
  factsChanged.current = onFactsChanged;
  React.useEffect(() => {
    if (observedFacts.current === factsKey) return;
    observedFacts.current = factsKey;
    factsChanged.current(factsKey);
  }, [factsKey]);
  const { names, workspaceRefs } = useSkillPlaces(scope?.serverId ?? serverId);
  const context = React.useMemo(() => {
    if (!machineId) return undefined;
    const candidatePath = target.draft?.directory ?? metadata?.path ?? '';
    const directory = metadata ? resolveSessionWorkspaceRootForMachine({ metadata, machineId, candidatePath }).machinePath : candidatePath;
    const workspaceId: unknown = metadata ? Reflect.get(metadata, 'workspaceId') : null;
    const projectId: unknown = metadata ? Reflect.get(metadata, 'projectId') : null;
    const ref = scope && directory && typeof workspaceId === 'string'
      ? resolveWorkspaceRefV1(workspaceRefs, { serverId: scope.serverId, workspaceId, machineId, rootPath: directory }) : null;
    const resolvedProject = ref?.kind === 'resolved' ? projectWorkspaceRefV1(ref.ref).projectKey : null;
    // Until the accepted checkout is available, keep the Machine's resolved preview.
    if (typeof workspaceId === 'string' && (ref?.kind !== 'resolved' || projectId !== undefined && projectId !== resolvedProject)) return undefined;
    const projectKey = target.draft?.projectKey ?? (projectId === undefined || projectId === resolvedProject ? resolvedProject : null);
    return { machineId, machinePlatform: modelInput.view && 'machinePlatform' in modelInput.view ? modelInput.view.machinePlatform : machine?.platform ?? null,
      directory: directory || null, projectKey, agentId };
  }, [machineId, target.draft?.directory, target.draft?.projectKey, metadata, scope, workspaceRefs, modelInput.view, machine?.platform, agentId]);
  const ids = React.useMemo(() => machineId ? [machineId] : [], [machineId]);
  const found = useFoundSkillsCache(ids, scope);
  const nativeSkills = React.useMemo(() => {
    if (!machineId || !agentId) return undefined;
    const catalog = SessionSkillCatalogListResponseV1Schema.safeParse(nativeCatalogInput);
    const items = new Map<string, Readonly<{ name: string; path: string }>>();
    // A Session's published catalog takes precedence over last-known Machine Found facts.
    if (catalog.success) {
      for (const item of catalog.data.skills) {
        if (item.origin === 'vendor' && item.path && (!item.backendId || item.backendId === agentId)) items.set(item.name, { name: item.name, path: item.path });
      }
    } else {
      for (const item of found[machineId]?.items ?? []) {
        if (item.agents.some(agent => agent === agentId) && !item.happierInstalled && item.scope === 'user') items.set(item.name, { name: item.name, path: item.path });
      }
    }
    for (const item of modelInput.view?.skills.plan.nativeDisables ?? []) if (!items.has(item.name)) items.set(item.name, { name: item.name, path: item.path });
    const declaration = machine?.agentDeclarationsById?.[agentId]?.capabilities?.skills;
    const bundled = !machine?.agentDeclarationsById && isBundledAgentId(agentId) ? getAgentCore(agentId)?.skills : null;
    return { items: [...items.values()], canDisable: (declaration ?? bundled)?.nativeDisable === 'supported',
      machineName, agentName: names.agentName(agentId), applyTiming: modelInput.applyState?.applyTiming?.mcp ?? modelInput.view?.applyTiming.mcp ?? { t: 'session_not_running' as const } };
  }, [machineId, agentId, nativeCatalogInput, found, modelInput.view?.skills.plan, modelInput.view?.applyTiming.mcp,
    modelInput.applyState?.applyTiming?.mcp, machine?.agentDeclarationsById, machineName, names]);
  const messages = getStorage()(state => target.sessionId && areServerAccountScopesEqual(scope, state.sessionLocalStateScope)
    ? state.sessionMessages[target.sessionId]?.messagesById ?? EMPTY_MESSAGES : EMPTY_MESSAGES);
  const notices = React.useMemo(() => Object.values(messages).flatMap(message => {
    const notice = message.kind === 'agent-event' ? readSessionCapabilityNoticeV1(message.event) : null;
    return notice ? [notice] : [];
  }), [messages]);
  const servers = React.useMemo(
    () =>
      new Map((mcpCatalog?.servers ?? []).map((entry) => [entry.id, entry])),
    [mcpCatalog],
  );
  const skills = React.useMemo(
    () => new Map(library.items.map((item) => [item.skillId, item])),
    [library.items],
  );
  const [signInRequest, setSignInRequest] = React.useState<Readonly<{ id: string; stepUp: boolean }> | null>(null);
  const signInMachines = React.useMemo(() => machineId ? [{ machineId, name: machineName, online: machineOnline }] : [], [machineId, machineName, machineOnline]);
  const signIn = useMcpServerSignIn(signInRequest ? servers.get(signInRequest.id) ?? null : null, signInMachines, {
    scope, ...(target.sessionId ? { returnTo: `/session/${encodeURIComponent(target.sessionId)}?serverId=${encodeURIComponent(scope?.serverId ?? '')}&capabilities=open` } : {}),
  });
  const startSignIn = React.useRef(signIn.start);
  startSignIn.current = signIn.start;
  React.useEffect(() => { if (signInRequest) void startSignIn.current({ stepUp: signInRequest.stepUp }); }, [signInRequest]);
  const freshCost = React.useCallback((kind: 'skill' | 'mcp_server', id: string): CapabilityCost | null => {
    if (kind === 'skill') {
      const cost = skills.get(id)?.cost;
      return cost ? { tokensWhenUsed: cost.bodyTokens } : null;
    }
    const entry = servers.get(id);
    const snapshot = entry?.toolsSnapshot;
    if (!entry || !snapshot) return null;
    const toolsDeclaration = agentId ? machine?.agentDeclarationsById?.[agentId]?.capabilities?.tools
      ?? (!machine?.agentDeclarationsById && isBundledAgentId(agentId) ? getAgentCore(agentId)?.tools : null) : null;
    const hidesOff = toolsDeclaration?.mcpToolControl?.off === 'hidden';
    const tools = snapshot.tools.filter(tool => !hidesOff || resolveMcpToolDecisionV1({ policy: entry.tools, toolName: tool.name,
      annotations: tool.annotations, permissionMode: 'default' }).exposed);
    return { toolCount: tools.length, tokensPerTurn: tools.reduce((sum, tool) => sum + tool.tokens, 0) };
  }, [skills, servers, agentId, machine?.agentDeclarationsById]);
  const detail = React.useMemo<Detail>(
    () => ({
      rules,
      names,
      context,
      nativeSkills,
      cost: (kind, id) => freshCost(kind, id) ?? lastKnownCosts?.get(`${kind}:${id}`) ?? null,
      skillStatus: (skillId) => {
        const item = skills.get(skillId);
        return skillStatus(item ?? null, undefined, { skillId, plan: modelInput.view?.skills.plan ?? null, notices, machineName,
          onFix: () => router.push(skillHref(skillId) as never) });
      },
      mcpStatus: (serverId) => {
        const entry = servers.get(serverId);
        if (!entry) return NO_STATUSES;
        const open = () => router.push(mcpServerRoute(serverId) as never);
        return mcpServerStatus({
          entry,
          signIn: signInRequest?.id === serverId ? signIn.fact : mcpSignInFact(
            mcpSignInGrantView(
              entry,
              findMcpSignInGrant(grants, serverId),
              machineOnline,
              diagnostics[serverId],
            ),
          ),
          tests: {},
          machines: signInMachines,
          sessionNotices: notices,
          savedSecretCatalog,
          fixes: {
            signIn: () => setSignInRequest({ id: serverId, stepUp: false }),
            reconnect: () => setSignInRequest({ id: serverId, stepUp: false }),
            grantAccess: () => setSignInRequest({ id: serverId, stepUp: true }),
            addKey: open,
            howToFix: open,
            tryAgain: open,
          },
        });
      },
    }),
    [context, nativeSkills, freshCost, lastKnownCosts, notices, machineName, modelInput.view?.skills.plan, signInRequest, signIn.fact,
      signInMachines, diagnostics, rules, names, skills, servers, savedSecretCatalog, grants, machineOnline, router],
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
    onRetry: (factsKey?: string) => void;
    machineName: string;
    maxHeight: number;
    target: SheetTarget;
    undo?: SessionCapabilitiesUndo | null;
    /** What the chip remembers of this Session's last sheet (read once, when the sheet opens). */
    readKnown: () => SessionCapabilitiesLastKnown | null;
    onKnown: (known: SessionCapabilitiesLastKnown) => void;
  }>,
) {
  const router = useRouter();
  const [known] = React.useState(props.readKnown);
  const { detail, renderMark } = useSessionCapabilitiesDetail(
    props.serverId,
    props.base.machineOnline === undefined ? true : props.base.machineOnline,
    props.onRetry,
    props.target,
    props.modelInput,
    props.machineName,
    known?.costs,
  );
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
  // The chip keeps what this sheet now knows, so the next open holds its size and its cost facts.
  const { onKnown } = props;
  const { view } = props.modelInput;
  React.useEffect(() => {
    if (view === null) return;
    const costs = new Map<string, CapabilityCost>();
    for (const item of [...view.skills.items, ...view.mcp.items]) {
      const cost = detail.cost?.(item.kind, item.id);
      if (cost) costs.set(`${item.kind}:${item.id}`, cost);
    }
    onKnown({ rows: { skills: model.groups[0].rows.length, mcp: model.groups[1].rows.length }, costs });
  }, [view, detail, model.groups, onKnown]);
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
      undo={props.undo}
      onRetry={props.onRetry}
      onOpen={onOpen}
      renderMark={renderMark}
      machineName={props.machineName}
      maxHeight={props.maxHeight}
      knownRows={known?.rows}
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
    onRetry: (factsKey?: string) => void;
    demandPreview: () => void;
    openRequest?: Readonly<{ consume: () => void }> | null;
    target: SheetTarget;
    undo?: SessionCapabilitiesUndo | null;
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
    openRequest,
    target,
    undo,
  } = params;
  // Unknown is never zero: until the first preview the chip names what it holds, not "0 skills".
  const label = modelInput.view ? model.chipLabel : `${t('capabilities.skills.title')} · MCP`;
  const attention = model.attention || sheetAttention;
  // What this Session's sheet last knew (its rows and cost facts), in memory only: the chip outlives the open sheet.
  const knownRef = React.useRef<Readonly<{ key: string; known: SessionCapabilitiesLastKnown }> | null>(null);
  const readKnown = React.useCallback(
    () => (knownRef.current?.key === stabilityKey ? knownRef.current.known : null),
    [stabilityKey],
  );
  const onKnown = React.useCallback(
    (known: SessionCapabilitiesLastKnown) => {
      knownRef.current = { key: stabilityKey, known };
    },
    [stabilityKey],
  );
  return React.useMemo(
    () =>
      createCapabilitiesActionChip({
        label,
        attention,
        stabilityKey,
        onIntent: demandPreview,
        openRequest,
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
            target={target}
            undo={undo}
            readKnown={readKnown}
            onKnown={onKnown}
          />
        ),
      }),
    [
      readKnown,
      onKnown,
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
      openRequest,
      height,
      target,
      undo,
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
    /** REACH's presence for the draft's machine; omitted where no machine is chosen yet (authoring). */
    machineOnline?: boolean | null;
  }>,
): Readonly<{
  chip: AgentInputExtraActionChip;
  model: SessionCapabilitiesModel;
  /** The composer `$` source: a library pick edits this same draft. */
  skillSource: SkillComposerSource | null;
}> {
  const machineOnline = params.machineOnline;
  const closedInput = React.useMemo(
    () => ({ ...CLOSED_DETAIL, ...(machineOnline === undefined ? {} : { machineOnline }) }),
    [machineOnline],
  );
  const popover = useNewSessionCapabilitiesPopover(params.draft, closedInput);
  const { setItem, refresh } = popover;
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => setItem(change.kind, change.id, change.state),
    [setItem],
  );
  const onRetry = React.useCallback((factsKey?: string) => {
    void refresh(factsKey);
  }, [refresh]);
  const draft = params.draft;
  const target = React.useMemo<SheetTarget>(() => ({ draft: { machineId: draft.machineId, directory: draft.directory,
    agentId: draft.agentId, projectKey: draft.projectKey } }), [draft.machineId, draft.directory, draft.agentId, draft.projectKey]);
  const stabilityKey = `draft:${draft.machineId ?? ''}:${draft.directory}:${draft.agentId}:${draft.targetServerId ?? ''}`;
  // The open sheet names the draft's machine (offline line, "<machine>'s copy wins").
  const machineName = params.machineName;
  const base = React.useMemo<Base>(
    () => ({ machineName, ...(machineOnline === undefined ? {} : { machineOnline }) }),
    [machineName, machineOnline],
  );
  const chip = useCapabilitiesChip({
    model: popover.model,
    modelInput: popover.modelInput,
    base,
    stabilityKey,
    serverId: draft.targetServerId ?? null,
    machineName: params.machineName,
    onChange,
    onRetry,
    demandPreview: popover.demandPreview,
    target,
  });
  const skillSource = useSkillComposerSource({ serverId: draft.targetServerId ?? null, agentId: draft.agentId,
    machineId: draft.machineId ?? null, machineName: params.machineName, owner: setItem });
  return { chip, model: popover.model, skillSource };
}

/**
 * The composer chip and the one apply line for an existing session: P2's session owner writes through
 * `session.capabilities.set` (optimistic, rolled back on failure, Undo resends the previous override).
 */
export function useExistingSessionCapabilitiesChip(
  params: Readonly<{
    target: Extract<SessionCapabilitiesTarget, { kind: 'session' }>;
    machineName: string;
    machineOnline: boolean | null;
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
  /** The composer `$` source: a library pick writes through this Session's own controller and apply line. */
  skillSource: SkillComposerSource | null;
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
  const target = React.useMemo<SheetTarget>(() => ({ sessionId, metadata: popover.metadata }), [sessionId, popover.metadata]);
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
  const onRetry = React.useCallback((factsKey?: string) => {
    void refresh(factsKey);
  }, [refresh]);
  const { undoReceipt, undoLast } = popover;
  const undo = React.useMemo<SessionCapabilitiesUndo | null>(
    () =>
      undoReceipt
        ? {
            title: undoReceipt.title,
            change: undoReceipt.change,
            onUndo: () => {
              void undoLast().then((result) => {
                if (!result.ok && result.message !== 'read_only') {
                  publishPresentationNotice({
                    key: `session-capabilities:${sessionId}`,
                    message: t('capabilities.control.changeFailed'),
                    severity: 'error',
                  });
                }
              });
            },
          }
        : null,
    [undoReceipt, undoLast, sessionId],
  );
  const route = useSessionCapabilitiesOpenRequest();
  const { consume } = route;
  const openRequest = React.useMemo(
    () => (route.requested ? { consume } : null),
    [route.requested, consume],
  );
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
    openRequest,
    target,
    undo,
  });
  const { badge } = useSessionCapabilityRestart({
    notice: popover.model.applyNotice,
    stop: params.stop,
    resume: params.resume,
  });
  const sessionMetadata = React.useMemo(() => {
    const parsed = MetadataSchema.safeParse(popover.metadata);
    return parsed.success ? parsed.data : null;
  }, [popover.metadata]);
  const skillSource = useSkillComposerSource({ serverId: params.target.serverId,
    agentId: sessionMetadata ? resolveAgentIdFromSessionMetadata(sessionMetadata) : null,
    machineId: sessionMetadata?.machineId ?? null, machineName, owner: setItem,
    applyTiming: popover.applyTiming?.skills ?? null });
  return {
    chip,
    model: popover.model,
    applyBadge: badge,
    undoLast: popover.undoLast,
    skillSource,
  };
}
