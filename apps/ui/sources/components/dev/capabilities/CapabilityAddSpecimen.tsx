import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { openCapabilityAddModal, type CapabilityAddModalConfig, type CapabilityAddModalHandle } from '@/components/capabilities/add/CapabilityAddModal';
import {
  CapabilityFacts,
  type CapabilityTrust,
} from '@/components/capabilities/facts/CapabilityFacts';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';

/**
 * Dev-only (P5 U5.1 prototype): the capability add modal with the lab's cast (`sa-A1`/`sa-A2`). Deleted when the
 * shell lands with its first product consumer (P6 U6.4 / P7 U7.10 / P9 U9.4). `?open=1` opens it on arrival.
 */
type CatalogSkill = Readonly<{
  name: string;
  repo: string;
  description: string;
  trust: CapabilityTrust;
  tokens: number;
  via: string;
  inLibrary?: boolean;
  status?: 'update';
}>;

const CAST: readonly CatalogSkill[] = [
  {
    name: 'frontend-design',
    repo: 'anthropics/skills',
    description:
      'Distinctive, production-grade web UI that avoids the generic look.',
    trust: 'text_only',
    tokens: 1900,
    via: 'via skills.sh',
    inLibrary: true,
  },
  {
    name: 'docx',
    repo: 'anthropics/skills',
    description:
      'Create and edit Word documents, with tracked changes and comments.',
    trust: 'runs_scripts',
    tokens: 3100,
    via: 'via skills.sh',
  },
  {
    name: 'webapp-testing',
    repo: 'anthropics/skills',
    description:
      'Drive a local web app with Playwright and check what you see.',
    trust: 'runs_scripts',
    tokens: 1600,
    via: 'via skills.sh',
  },
  {
    name: 'systematic-debugging',
    repo: 'obra/superpowers',
    description:
      'Find the root cause before fixing: reproduce, narrow, hypothesise, test.',
    trust: 'text_only',
    tokens: 1200,
    via: 'via skills.sh',
  },
  {
    name: 'incident-postmortem',
    repo: 'acme/agent-plugins',
    description:
      'Write a blameless postmortem from an incident channel and timeline.',
    trust: 'has_files',
    tokens: 900,
    via: 'via Acme plugins',
  },
  {
    name: 'frontend-perf',
    repo: 'addyosmani/web-skills',
    description:
      'Find and fix the slow parts of a page from Lighthouse traces.',
    trust: 'runs_scripts',
    tokens: 2100,
    via: 'via skills.sh',
    status: 'update',
  },
  {
    name: 'mcp-builder',
    repo: 'anthropics/skills',
    description: 'Build an MCP server step by step, with tests and a manifest.',
    trust: 'has_files',
    tokens: 2400,
    via: 'via skills.sh',
  },
  {
    name: 'changelog-writer',
    repo: 'leeroy/agent-skills',
    description: 'Match the house changelog format from merged pull requests.',
    trust: 'text_only',
    tokens: 600,
    via: 'via leeroy/agent-skills',
  },
];

function Provenance() {
  const { theme } = useUnistyles();
  return <Text variant="meta" style={{ color: theme.colors.text.secondary }}>Pinned to 4f2a1c9</Text>;
}

function InLibrary() {
  const { theme } = useUnistyles();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 }}>
      <Icon name="check" size={12} color={theme.colors.text.secondary} />
      <Text variant="meta" style={{ color: theme.colors.text.secondary }}>In your library</Text>
    </View>
  );
}

function SkillDetail(props: Readonly<{ skill: CatalogSkill }>) {
  const { theme } = useUnistyles();
  const skill = props.skill;
  return (
    <View style={{ gap: theme.space.s24 }}>
      <View style={{ gap: theme.space.s8 }}>
        <Text variant="title" emphasis="strong" style={{ color: theme.colors.text.primary }}>
          {skill.name}
        </Text>
        <Text variant="reading" style={{ color: theme.colors.text.secondary }}>
          {skill.description}
        </Text>
        <CapabilityFacts
          presentation="row"
          source={{ kind: 'git', label: skill.repo, ref: '4f2a1c9' }}
          trust={skill.trust}
          cost={{ tokensWhenUsed: skill.tokens }}
        />
      </View>
      <ItemGroup title="What it installs" surface="none">
        <Item
          title="Runs scripts"
          subtitle="Two Python scripts. Nothing runs when you add it; an agent may run them when it uses the skill, under the session's permissions."
          icon={
            <Icon
              name="terminal"
              size={18}
              color={theme.colors.text.secondary}
            />
          }
        />
        <Item
          title={`About ${(skill.tokens / 1000).toFixed(1)}k tokens when used`}
          subtitle="45 tokens in every session for its description, so agents know it's there."
          icon={
            <Icon
              name="chat-circle"
              size={18}
              color={theme.colors.text.secondary}
            />
          }
        />
        <Item
          title={skill.repo}
          subtitle="Found on skills.sh · pinned to 4f2a1c9 · changes wait for your review"
          icon={
            <Icon
              name="github-logo"
              size={18}
              color={theme.colors.text.secondary}
            />
          }
        />
      </ItemGroup>
    </View>
  );
}

function CatalogModalHost(props: Readonly<{ openOnArrival: boolean }>) {
  const [query, setQuery] = React.useState('');
  const config = React.useMemo<CapabilityAddModalConfig<CatalogSkill>>(() => ({
      title: 'Add a skill',
      testID: 'capability-add',
      modes: [
        {
          key: 'browse',
          label: 'Browse',
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'link',
          label: 'From a link',
          icon: 'link',
          kind: 'input',
          renderBody: () => (
            <View style={{ padding: 24 }}>
              <Text variant="body">
                Paste a GitHub link or a skills.sh page.
              </Text>
            </View>
          ),
        },
        {
          key: 'upload',
          label: 'Upload',
          icon: 'upload',
          kind: 'input',
          renderBody: () => (
            <View style={{ padding: 24 }}>
              <Text variant="body">Drop a SKILL.md or a folder.</Text>
            </View>
          ),
        },
        {
          key: 'write',
          label: 'Write',
          icon: 'pencil-simple',
          kind: 'handoff',
          onSelect: () => {},
        },
      ],
      catalog: {
        query,
        onQueryChange: setQuery,
        searchPlaceholder: 'Search 1.2k skills',
        items: CAST.filter((skill) => query.trim() === '' || `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())),
        groups: [
          {
            key: 'popular',
            title: 'Popular in your registries',
            trailing: 'Most added this month',
            itemKeys: CAST.map((skill) => skill.name),
          },
        ],
        itemKey: (skill) => skill.name,
        anatomy: buildCapabilityCollectionAnatomy<CatalogSkill>({
          title: (skill) => skill.name,
          description: (skill) => skill.description,
          whereSummary: (skill) =>
            skill.inLibrary === true ? <InLibrary /> : null,
          facts: (skill) => ({
            presentation: 'row',
            source: { kind: 'git', label: skill.repo },
            trust: skill.trust,
            cost: { tokensWhenUsed: skill.tokens },
            extra: [skill.via],
          }),
          status: (skill) =>
            skill.status === undefined ? null : { kind: skill.status },
          action: (skill) =>
            skill.inLibrary === true ? null : (
              <RoundButton
                size="small"
                display="secondary"
                title="Add"
                onPress={() => {}}
              />
            ),
          accessibilityLabel: (skill) => skill.name,
          testID: (skill) => `capability-add-row:${skill.name}`,
        }),
        loading: false,
        empty: <Text variant="body">No skills match.</Text>,
      },
      renderDetail: (skill) => <SkillDetail skill={skill} />,
      detailFooter: () => ({
        provenance: <Provenance />,
        primary: {
          label: 'Add to library',
          onPress: async () => ({ itemId: 'docx' }),
        },
      }),
  }), [query]);
  const handle = React.useRef<CapabilityAddModalHandle<CatalogSkill> | null>(null);
  const open = React.useCallback(() => {
    handle.current = openCapabilityAddModal(config);
  }, [config]);
  React.useEffect(() => {
    handle.current?.update(config);
  }, [config]);
  React.useEffect(() => {
    if (props.openOnArrival) open();
    // Opens once on arrival for the side-by-side; the query lives in this dev host only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <RoundButton
      title="Open Add a skill"
      onPress={open}
      testID="capability-add-open"
    />
  );
}

export function CapabilityAddSpecimen(
  props: Readonly<{ openOnArrival: boolean }>,
) {
  return (
    <View style={styles.page}>
      <CatalogModalHost openOnArrival={props.openOnArrival} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    padding: theme.space.s32,
    alignItems: 'flex-start',
    backgroundColor: theme.colors.surface.base,
  },
}));
