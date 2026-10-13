import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { SessionSkillPlanV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';

import type { CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { AgentInput } from '@/components/sessions/agentInput/AgentInput';
import { createCapabilitiesActionChip, SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO } from '@/components/sessions/capabilities/createCapabilitiesActionChip';
import {
  SessionCapabilitiesContent,
  type SessionCapabilitiesChange,
} from '@/components/sessions/capabilities/SessionCapabilitiesContent';
import {
  buildSessionCapabilitiesModel,
  type SessionCapabilitiesModel,
  type SessionCapabilitiesViewInput,
} from '@/components/sessions/capabilities/sessionCapabilitiesModel';
import { sessionCapabilityApplyBadge } from '@/components/sessions/capabilities/sessionCapabilityApplyBadge';
import { McpServerMark } from '@/components/settings/mcpServers/identity/McpServerMark';
import { PageHeader } from '@/components/ui/layout/PageHeader';

/**
 * Dev-only (P8 U8.3 shell first, IR-82; deleted when Lane 12 Main mounts the chip in the real composers):
 * "This session gets" on the real composer with the lab cast (xn A new session, xn E existing session)
 * and the F1/F2 states. `?scene=new|existing|resolving|offline|error|empty`.
 */
type Scene = 'new' | 'existing' | 'resolving' | 'offline' | 'error' | 'empty';
type CastItem = Readonly<{
  kind: 'skill' | 'mcp_server';
  id: string;
  title?: string;
  place: 'everywhere' | 'project' | 'off';
  override?: 'added' | 'removed';
  status?: CapabilityStatus['kind'];
  machine?: string;
  fix?: NonNullable<CapabilityStatus['fix']>['kind'];
  cost?: CapabilityCost;
}>;

const noop = () => {};
const NEW_PROMPT = 'The contact form drops submissions in Safari when the page was restored from the back cache. Find out why and fix it.';
const NEW_CAST: readonly CastItem[] = [
  {
    kind: 'skill',
    id: 'frontend-design',
    place: 'project',
    override: 'removed',
    cost: { tokensWhenUsed: 1900 },
  },
  {
    kind: 'skill',
    id: 'sql-migrations',
    place: 'off',
    override: 'added',
    cost: { tokensWhenUsed: 1100 },
  },
  {
    kind: 'skill',
    id: 'deploy-checklist',
    place: 'project',
    status: 'masked',
    machine: 'MacBook Pro',
    cost: { tokensWhenUsed: 640 },
  },
  {
    kind: 'skill',
    id: 'code-review',
    place: 'everywhere',
    cost: { tokensWhenUsed: 1400 },
  },
  {
    kind: 'skill',
    id: 'pdf',
    place: 'everywhere',
    cost: { tokensWhenUsed: 2300 },
  },
  {
    kind: 'skill',
    id: 'release-notes',
    place: 'everywhere',
    cost: { tokensWhenUsed: 820 },
  },
  {
    kind: 'skill',
    id: 'happier-diagnose',
    place: 'everywhere',
    cost: { tokensWhenUsed: 380 },
  },
  {
    kind: 'skill',
    id: 'changelog',
    place: 'off',
    cost: { tokensWhenUsed: 700 },
  },
  {
    kind: 'mcp_server',
    id: 'sentry',
    title: 'Sentry',
    place: 'everywhere',
    status: 'expired',
    fix: 'reconnect',
    cost: { toolCount: 14, tokensPerTurn: 3000 },
  },
  {
    kind: 'mcp_server',
    id: 'postgres',
    title: 'Postgres',
    place: 'off',
    override: 'added',
    status: 'key',
    fix: 'add_key',
    cost: { toolCount: 6, tokensPerTurn: 900 },
  },
  {
    kind: 'mcp_server',
    id: 'github',
    title: 'GitHub',
    place: 'everywhere',
    cost: { toolCount: 41, tokensPerTurn: 7800 },
  },
  {
    kind: 'mcp_server',
    id: 'linear',
    title: 'Linear',
    place: 'everywhere',
    cost: { toolCount: 23, tokensPerTurn: 4100 },
  },
  {
    kind: 'mcp_server',
    id: 'playwright',
    title: 'Playwright',
    place: 'everywhere',
    cost: { toolCount: 21, tokensPerTurn: 5200 },
  },
  {
    kind: 'mcp_server',
    id: 'context7',
    title: 'Context7',
    place: 'everywhere',
    cost: { toolCount: 2, tokensPerTurn: 400 },
  },
  {
    kind: 'mcp_server',
    id: 'fetch',
    title: 'Fetch',
    place: 'everywhere',
    cost: { toolCount: 1, tokensPerTurn: 300 },
  },
  {
    kind: 'mcp_server',
    id: 'figma',
    title: 'Figma',
    place: 'off',
    cost: { toolCount: 9, tokensPerTurn: 2100 },
  },
];
const EXISTING_CAST: readonly CastItem[] = [
  {
    kind: 'skill',
    id: 'code-review',
    place: 'everywhere',
    override: 'removed',
    cost: { tokensWhenUsed: 1400 },
  },
  {
    kind: 'skill',
    id: 'pdf',
    place: 'everywhere',
    status: 'cantrun',
    machine: 'nl2',
    fix: 'how_to_fix',
    cost: { tokensWhenUsed: 2300 },
  },
  {
    kind: 'skill',
    id: 'release-notes',
    place: 'everywhere',
    cost: { tokensWhenUsed: 820 },
  },
  {
    kind: 'skill',
    id: 'sql-migrations',
    place: 'everywhere',
    cost: { tokensWhenUsed: 1100 },
  },
  {
    kind: 'skill',
    id: 'happier-diagnose',
    place: 'everywhere',
    cost: { tokensWhenUsed: 380 },
  },
  {
    kind: 'mcp_server',
    id: 'linear',
    title: 'Linear',
    place: 'off',
    override: 'added',
    cost: { toolCount: 23, tokensPerTurn: 4100 },
  },
  {
    kind: 'mcp_server',
    id: 'sentry',
    title: 'Sentry',
    place: 'everywhere',
    status: 'expired',
    fix: 'reconnect',
    cost: { toolCount: 14, tokensPerTurn: 3000 },
  },
  {
    kind: 'mcp_server',
    id: 'postgres',
    title: 'Postgres',
    place: 'project',
    status: 'key',
    fix: 'add_key',
    cost: { toolCount: 6, tokensPerTurn: 900 },
  },
  {
    kind: 'mcp_server',
    id: 'github',
    title: 'GitHub',
    place: 'everywhere',
    cost: { toolCount: 41, tokensPerTurn: 7800 },
  },
  {
    kind: 'mcp_server',
    id: 'playwright',
    title: 'Playwright',
    place: 'everywhere',
    cost: { toolCount: 21, tokensPerTurn: 5200 },
  },
  {
    kind: 'mcp_server',
    id: 'context7',
    title: 'Context7',
    place: 'everywhere',
    cost: { toolCount: 2, tokensPerTurn: 400 },
  },
  {
    kind: 'mcp_server',
    id: 'fetch',
    title: 'Fetch',
    place: 'everywhere',
    cost: { toolCount: 1, tokensPerTurn: 300 },
  },
];

function ruleFor(item: CastItem, projectKey: string): ReachRuleV1 {
  const target =
    item.place === 'project'
      ? { t: 'project' as const, projectKey }
      : { t: 'allMachines' as const };
  return {
    id: `${item.kind}:${item.id}`,
    target,
    enabled: item.place !== 'off',
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildView(
  cast: readonly CastItem[],
  existing: boolean,
): SessionCapabilitiesViewInput {
  const item = (entry: CastItem) => {
    const ruleOn = entry.place !== 'off';
    const selected =
      entry.override === 'added'
        ? true
        : entry.override === 'removed'
          ? false
          : ruleOn;
    return {
      kind: entry.kind,
      id: entry.id,
      name: entry.id,
      ...(entry.title ? { title: entry.title } : {}),
      selected,
      selectable: true,
      reason:
        entry.override === 'added'
          ? ('session_added' as const)
          : entry.override === 'removed'
            ? ('session_removed' as const)
            : ruleOn
              ? ('rule_on' as const)
              : ('rule_off' as const),
      decidedBy: {
        ruleId: `${entry.kind}:${entry.id}`,
        target:
          entry.place === 'project'
            ? ('project' as const)
            : ('allMachines' as const),
        agentQualified: false,
      },
      sessionOverride: entry.override ?? null,
    };
  };
  const parsed = SessionCapabilitiesGetOutputV1Schema.parse({
    ok: true,
    mcp: {
      items: cast
        .filter((entry) => entry.kind === 'mcp_server')
        .map((entry) => ({ ...item(entry), source: 'catalog' })),
    },
    skills: {
      items: cast
        .filter((entry) => entry.kind === 'skill')
        .map((entry) => ({
          ...item(entry),
          ...(entry.status === 'masked' ? { state: 'masked_by_native' } : {}),
        })),
      plan: SessionSkillPlanV1Schema.parse({
        plan: 'session_dir',
        items: [],
        nativeDisables: [],
        diagnostics: [],
      }),
    },
    pendingApply: { mcp: existing, skills: false },
    applyTiming: existing
      ? { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } }
      : {
          mcp: { t: 'session_not_running' },
          skills: { t: 'session_not_running' },
        },
  });
  if (!parsed.ok) throw new Error('invalid cast');
  return parsed;
}

function useSpecimenModel(scene: Scene) {
  const existing = scene === 'existing';
  const projectName = existing ? 'happier' : 'client-site';
  const machineName = existing ? 'nl2' : 'MacBook Pro';
  const [cast, setCast] = React.useState<readonly CastItem[]>(() =>
    scene === 'empty'
      ? NEW_CAST.filter((entry) => entry.kind === 'skill')
      : existing
        ? EXISTING_CAST
        : NEW_CAST,
  );
  const [lastChange, setLastChange] = React.useState<{
    title: string;
    kind: 'skill' | 'mcp_server';
    state: 'on' | 'off' | 'inherit';
  } | null>(
    existing ? { title: 'Linear', kind: 'mcp_server', state: 'on' } : null,
  );
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => {
      setCast((current) =>
        current.map((entry) =>
          entry.kind !== change.kind || entry.id !== change.id
            ? entry
            : {
                ...entry,
                override:
                  change.state === 'on'
                    ? entry.place === 'off'
                      ? 'added'
                      : undefined
                    : change.state === 'off'
                      ? 'removed'
                      : undefined,
              },
        ),
      );
      const entry = cast.find(
        (candidate) =>
          candidate.kind === change.kind && candidate.id === change.id,
      );
      if (entry && change.kind !== 'native_skill')
        setLastChange({
          title: entry.title ?? entry.id,
          kind: change.kind,
          state: change.state,
        });
    },
    [cast],
  );
  const model: SessionCapabilitiesModel = React.useMemo(() => {
    const byKey = new Map(
      cast.map((entry) => [`${entry.kind}:${entry.id}`, entry]),
    );
    const statuses =
      (kind: CastItem['kind']) =>
      (id: string): readonly CapabilityStatus[] => {
        const entry = byKey.get(`${kind}:${id}`);
        if (!entry?.status) return [];
        return [
          {
            kind: entry.status,
            ...(entry.machine ? { machineName: entry.machine } : {}),
            ...(entry.fix ? { fix: { kind: entry.fix, onPress: noop } } : {}),
          },
        ];
      };
    return buildSessionCapabilitiesModel({
      view: buildView(cast, existing),
      state:
        scene === 'resolving'
          ? 'resolving'
          : scene === 'offline'
            ? 'machine_unreachable'
            : scene === 'error'
              ? 'error'
              : 'ready',
      readOnly: false,
      rules: (kind, id) => {
        const entry = byKey.get(`${kind}:${id}`);
        return entry ? [ruleFor(entry, 'project')] : [];
      },
      mcpStatus: statuses('mcp_server'),
      skillStatus: statuses('skill'),
      cost: (kind, id) => byKey.get(`${kind}:${id}`)?.cost ?? null,
      names: {
        agentName: () => (existing ? 'Codex' : 'Claude'),
        machineName: () => machineName,
        projectName: () => projectName,
        folderLabel: () => projectName,
      },
      change: existing && lastChange ? lastChange : null,
      machineOnline: true,
      machineName,
      turnSettled: true,
    });
  }, [cast, scene, existing, lastChange, machineName, projectName]);
  return { model, onChange, machineName };
}

export function SessionCapabilitiesSpecimen(
  props: Readonly<{ scene?: string }>,
) {
  const scene: Scene =
    (
      ['new', 'existing', 'resolving', 'offline', 'error', 'empty'] as const
    ).find((candidate) => candidate === props.scene) ?? 'new';
  const { model, onChange, machineName } = useSpecimenModel(scene);
  const { height: windowHeight } = useWindowDimensions();
  // Resolving keeps the last-known rows (counts hold); a first resolve with nothing known shows the line state.
  const shown: SessionCapabilitiesModel =
    scene === 'resolving'
      ? {
          ...model,
          groups: model.groups.map((group) => ({
            ...group,
            rows: [],
            nativeRow: null,
          })),
        }
      : model;
  const chip = React.useMemo(
    () =>
      createCapabilitiesActionChip({
        label: shown.chipLabel,
        attention: shown.attention,
        stabilityKey: `dev:${scene}`,
        maxHeightCap: Math.round(windowHeight * SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO),
        popoverContent: ({ maxHeight }) => (
          <SessionCapabilitiesContent
            model={shown}
            onChange={onChange}
            testID="session-capabilities"
            maxHeight={maxHeight}
            machineName={machineName}
            onRetry={noop}
            onOpen={noop}
            renderMark={() => <McpServerMark transport="http" size={20} />}
          />
        ),
      }),
    [shown, onChange, scene, machineName, windowHeight],
  );
  const badge =
    scene === 'existing'
      ? sessionCapabilityApplyBadge(
          model.pendingNote
            ? { key: 'joinsNextTurn', text: model.pendingNote, restart: null }
            : null,
        )
      : null;
  const existing = scene === 'existing';
  const [text, setText] = React.useState(existing ? '' : NEW_PROMPT);
  return (
    <ScrollView
      contentContainerStyle={[
        styles.page,
        existing ? styles.sessionPage : null,
      ]}
    >
      {existing ? (
        <PageHeader
          title="Flaky relay soak test"
          description="Codex on nl2 · happier"
        />
      ) : (
        <PageHeader
          title="Good evening, Leeroy"
          description="2 sessions working"
        />
      )}
      <View style={existing ? styles.composerBottom : null}>
        <AgentInput
          value={text}
          onChangeText={setText}
          onSend={noop}
          placeholder={
            existing
              ? 'Message Flaky relay soak test…'
              : 'What should we work on?'
          }
          autocompleteKinds={[]}
          autocompleteSuggestions={async () => []}
          engineControls="none"
          voiceAffordance="none"
          messageHistory="none"
          extraActionChips={[chip]}
          {...(badge ? { statusBadges: [badge] } : {})}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    width: '100%',
    maxWidth: 1000,
    alignSelf: 'center',
    paddingHorizontal: theme.space.s24,
    paddingTop: theme.space.s48,
    gap: theme.space.s16,
  },
  sessionPage: { flexGrow: 1 },
  composerBottom: { marginTop: 'auto', paddingBottom: theme.space.s24 },
}));
