import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatCapabilityCount } from './formatCapabilityCount';

export type CapabilitySource =
  | Readonly<{ kind: 'you' }>
  | Readonly<{ kind: 'happier' }>
  | Readonly<{ kind: 'git'; label: string; ref?: string }>
  | Readonly<{ kind: 'registry'; label: string; mark?: React.ReactNode }>
  | Readonly<{ kind: 'machine'; machineName: string }>
  | Readonly<{ kind: 'plugin'; pluginName: string; mark?: React.ReactNode }>
  | Readonly<{ kind: 'link'; host: string }>;
export type CapabilityTrust = 'text_only' | 'has_files' | 'runs_scripts';
export type CapabilityCost = Readonly<{
  /** Skills: tokens the body costs when an agent loads it. */
  tokensWhenUsed?: number;
  /** MCP: tools exposed and their schema tokens every turn. */
  toolCount?: number;
  tokensPerTurn?: number;
}>;
export type CapabilityFactsProps = Readonly<{
  source?: CapabilitySource;
  trust?: CapabilityTrust;
  cost?: CapabilityCost;
  /** Extra facts after cost ("Remote", "via skills.sh"); a path or id is drawn in mono. */
  extra?: readonly (string | Readonly<{ text: string; mono: true }>)[];
  /** 'row': one quiet line, truncates at the end. */
  presentation: 'row';
}>;

type Fact = Readonly<{
  key: string;
  text: string;
  icon?: IconName;
  mark?: React.ReactNode;
  mono?: boolean;
  strong?: boolean;
}>;

const TRUST_ICON: Readonly<Record<CapabilityTrust, IconName>> = {
  text_only: 'file-text',
  has_files: 'folder',
  runs_scripts: 'terminal',
};

function sourceFact(source: CapabilitySource): Fact {
  switch (source.kind) {
    case 'you':
      return { key: 'source', text: t('capabilities.facts.you'), icon: 'user-circle' };
    case 'happier':
      return { key: 'source', text: t('capabilities.facts.happier') };
    case 'git':
      return { key: 'source', text: source.label, icon: 'github-logo' };
    case 'registry':
      return {
        key: 'source',
        text: source.label,
        ...(source.mark === undefined ? {} : { mark: source.mark }),
      };
    case 'machine':
      return { key: 'source', text: source.machineName, icon: 'desktop' };
    case 'plugin':
      return {
        key: 'source',
        text: source.pluginName,
        ...(source.mark === undefined ? {} : { mark: source.mark }),
      };
    case 'link':
      return { key: 'source', text: source.host, icon: 'link' };
  }
}

function trustText(trust: CapabilityTrust): string {
  if (trust === 'runs_scripts') return t('capabilities.facts.runsScripts');
  if (trust === 'has_files') return t('capabilities.facts.hasFiles');
  return t('capabilities.facts.textOnly');
}

/** The one owner of source · trust · cost words, for rows and entity headers alike. */
function buildFacts(
  input: Omit<CapabilityFactsProps, 'presentation'>,
): readonly Fact[] {
  const facts: Fact[] = [];
  if (input.source !== undefined) facts.push(sourceFact(input.source));
  // "Runs scripts" is the one trust fact that carries weight; the quieter two stay muted.
  if (input.trust !== undefined)
    facts.push({
      key: 'trust',
      text: trustText(input.trust),
      icon: TRUST_ICON[input.trust],
      strong: input.trust === 'runs_scripts',
    });
  const cost = input.cost;
  if (cost?.toolCount !== undefined)
    facts.push({
      key: 'tools',
      text: t('capabilities.facts.toolCount', {
        count: cost.toolCount,
        shown: formatCapabilityCount(cost.toolCount),
      }),
    });
  if (cost?.tokensPerTurn !== undefined)
    facts.push({
      key: 'tokensPerTurn',
      text: t('capabilities.facts.tokensPerTurn', {
        count: formatCapabilityCount(cost.tokensPerTurn),
      }),
    });
  if (cost?.tokensWhenUsed !== undefined)
    facts.push({
      key: 'tokens',
      text: t('capabilities.facts.tokensWhenUsed', {
        count: formatCapabilityCount(cost.tokensWhenUsed),
      }),
    });
  for (const [index, extra] of (input.extra ?? []).entries())
    facts.push(
      typeof extra === 'string'
        ? { key: `extra:${index}`, text: extra }
        : { key: `extra:${index}`, text: extra.text, mono: true },
    );
  return facts;
}

export function CapabilityFacts(
  props: CapabilityFactsProps,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const facts = buildFacts(props);
  if (facts.length === 0) return null;
  return (
    <View style={styles.line}>
      <Text variant="meta" numberOfLines={1} style={styles.text}>
        {facts.map((fact, index) => (
          <React.Fragment key={fact.key}>
            {index === 0 ? null : (
              <Text variant="meta" style={styles.dot} aria-hidden>
                {'  ·  '}
              </Text>
            )}
            {fact.mark ??
              (fact.icon === undefined ? null : (
                <Text variant="meta" style={styles.glyph}>
                  <Icon
                    name={fact.icon}
                    size={12}
                    color={theme.colors.text.tertiary}
                  />{' '}
                </Text>
              ))}
            <Text
              variant="meta"
              style={[
                fact.strong === true ? styles.strong : null,
                fact.mono === true ? styles.mono : null,
              ]}
            >
              {fact.text}
            </Text>
          </React.Fragment>
        ))}
      </Text>
    </View>
  );
}

/** The same facts for an entity header, through `PageHeader` `meta` (one owner for header facts). */
export function buildCapabilityHeaderMeta(
  input: Omit<CapabilityFactsProps, 'presentation'>,
): readonly PageHeaderMetaFact[] {
  return buildFacts(input).map((fact) => ({
    key: fact.key,
    text:
      fact.key === 'source' &&
      input.source?.kind === 'git' &&
      input.source.ref !== undefined
        ? `${fact.text} @${input.source.ref}`
        : fact.text,
    ...(fact.icon === undefined ? {} : { icon: fact.icon }),
  }));
}

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: 'row', minWidth: 0, flexShrink: 1 },
  text: { color: theme.colors.text.tertiary, flexShrink: 1 },
  dot: { color: theme.colors.text.tertiary },
  glyph: { color: theme.colors.text.tertiary },
  strong: { color: theme.colors.text.secondary },
  mono: { ...Typography.mono() },
}));
