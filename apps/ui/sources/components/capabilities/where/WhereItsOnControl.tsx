import * as React from 'react';
import { View, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierFieldBoxTrigger,
  HappierPressable,
  HappierWhereItsOnControl,
  collectHappierWhereItsOnAgentIds,
  resolveHappierFieldBoxLabel,
  useHappierWhereItsOnDraft,
  type HappierWhereItsOnChangeResult,
  type HappierWhereItsOnControlProps,
  type HappierWhereItsOnHost,
  type HappierWhereItsOnMenuItem,
} from '@happier-dev/plugin-ui/presentation';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import type { SessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { AgentNameRun } from '@/components/capabilities/identity/AgentNameRun';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ExpandableItem, ExpandableItemCaret } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useWhereItsOnNames } from './useWhereItsOnNames';
import { whereItsOnControlLabels, whereItsOnReach } from './whereItsOnPresentation';

/**
 * Happier's binding of the shared "Where it's on" control (`@happier-dev/plugin-ui` presentation owns what it shows,
 * in which order and what each control writes): Happier's names (Agent catalog identities, machines, Account
 * Projects), words and settings primitives.
 */
export type WhereItsOnChangeResult = HappierWhereItsOnChangeResult;
export type WhereItsOnControlProps = Omit<HappierWhereItsOnControlProps, 'names' | 'labels' | 'host' | 'reach' | 'space'> &
  Readonly<{
    /** Accepted from the detail pages but not drawn: the control has never offered Undo (pre-existing, unchanged). */
    onUndo?: () => Promise<void>;
  }>;

const ICON_SIZES = { xs: ICON_SIZE.xs, sm: ICON_SIZE.sm, md: ICON_SIZE.md } as const;

type Theme = ReturnType<typeof useUnistyles>['theme'];

function buildHost(theme: Theme, identityById: ReadonlyMap<string, SessionAgentCatalogIdentity>): HappierWhereItsOnHost {
  const tones = {
    primary: theme.colors.text.primary,
    secondary: theme.colors.text.secondary,
    tertiary: theme.colors.text.tertiary,
  } as const;
  const AgentMark: HappierWhereItsOnHost['AgentMark'] = ({ agentId, size }) => {
    const identity = identityById.get(agentId);
    if (!identity) return null;
    return (
      <AgentCatalogIdentityIcon
        entry={identity.entry}
        machineId={null}
        serverId={null}
        current={identity.current}
        size={ICON_SIZES[size]}
      />
    );
  };
  const PlaceGlyph: HappierWhereItsOnHost['PlaceGlyph'] = ({ name, size }) => (
    <Icon name={name} size={ICON_SIZES[size]} color={theme.colors.text.secondary} />
  );
  const menuItem = (item: HappierWhereItsOnMenuItem, category?: string): DropdownMenuItem => ({
    id: item.id,
    title: item.title,
    testID: item.testID,
    ...(category !== undefined ? { category } : {}),
    ...(item.checked !== undefined ? { checked: item.checked } : {}),
    ...(item.mark?.kind === 'agent'
      ? { icon: <AgentMark agentId={item.mark.agentId} size="sm" /> }
      : item.mark?.kind === 'icon'
        ? { icon: <PlaceGlyph name={item.mark.name} size="sm" /> }
        : {}),
    ...(item.trailing
      ? {
          rightElement: (
            <Text
              variant="meta"
              style={{
                color: theme.colors.text.tertiary,
                ...(item.trailing.tabular ? { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] } : {}),
              }}
            >
              {item.trailing.text}
            </Text>
          ),
        }
      : {}),
  });
  return {
    Section: ({ testID, title, description, children }) => (
      <ItemGroup testID={testID} title={title} {...(description !== undefined ? { description } : {})}>
        {children}
      </ItemGroup>
    ),
    Disclosure: ({ testID, rowTestID, expanded, onExpandedChange, title, changeLabel, showDivider, children }) => (
      <ExpandableItem
        testID={testID}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        showDivider={showDivider ?? false}
        header={({ headerProps, expanded: open }) => (
          <Item
            {...(headerProps as Readonly<Record<string, unknown>>)}
            testID={rowTestID}
            title={title}
            rightElement={
              changeLabel !== undefined && !open ? (
                <Text variant="label" style={{ color: theme.colors.text.link ?? theme.colors.text.secondary }}>
                  {changeLabel}
                </Text>
              ) : (
                <ExpandableItemCaret expanded={open} />
              )
            }
            showChevron={false}
          />
        )}
      >
        {children}
      </ExpandableItem>
    ),
    Everywhere: ({ testID, title, subtitle, options, value, disabled, onChange }) => (
      <SegmentedChoiceItem
        testID={testID}
        testIDPrefix={testID}
        title={title}
        subtitle={subtitle}
        options={options}
        value={value}
        disabled={disabled}
        onChange={onChange}
        showDivider
      />
    ),
    RuleList: SectionLeadingColumnProvider,
    GroupLabel: ({ title }) => <CollectionListGroupLabel title={title} />,
    Rule: ({ testID, title, subtitle, mark, wideControls, controls, note }) => (
      <Item
        testID={testID}
        title={title}
        subtitle={subtitle}
        icon={mark}
        // A lone Remove is a narrow control and stays beside the label; with the agents select the pair moves beneath on a phone.
        {...(wideControls ? { accessoryLayout: 'adaptive' as const } : {})}
        rightElement={controls}
        {...(note !== undefined ? { bottomElement: note, bottomElementInset: 'text' as const } : {})}
        showChevron={false}
        showDivider={false}
      />
    ),
    RemoveButton: ({ testID, accessibilityLabel, onPress }) => (
      <IconButton iconName="x" variant="plain" accessibilityLabel={accessibilityLabel} testID={testID} onPress={onPress} />
    ),
    AddMenu: function AddMenu({ testID, title, groups, onSelect }) {
      const [open, setOpen] = React.useState(false);
      const items = React.useMemo(
        () => groups.flatMap((group) => group.items.map((item) => menuItem(item, group.title))),
        [groups],
      );
      return (
        <DropdownMenu
          testID={`${testID}Menu`}
          open={open}
          onOpenChange={setOpen}
          items={items}
          onSelect={onSelect}
          showCategoryTitles
          matchTriggerWidth={false}
          rowKind="item"
          popoverPhonePresentation="sheet"
          popoverAccessibilityLabel={title}
          trigger={({ toggle, open: isOpen }) => (
            <SectionActionButton testID={testID} icon="plus" title={title} expanded={isOpen} onPress={toggle} />
          )}
        />
      );
    },
    AgentSelect: function AgentSelect({ testID, label, accessibilityLabel, selectedAgentId, items, selectedId, onSelect }) {
      const [open, setOpen] = React.useState(false);
      const menuItems = React.useMemo(() => items.map((item) => menuItem(item)), [items]);
      const fieldColors = resolveFieldBoxColors(theme);
      const fieldLabel = resolveHappierFieldBoxLabel({ value: label, placeholder: label, colors: fieldColors });
      return (
        <DropdownMenu
          testID={testID}
          open={open}
          onOpenChange={setOpen}
          items={menuItems}
          selectedId={selectedId}
          onSelect={onSelect}
          matchTriggerWidth={false}
          popoverPhonePresentation="sheet"
          popoverAccessibilityLabel={accessibilityLabel}
          trigger={({ toggle, open: isOpen }) => (
            <HappierPressable
              testID={`${testID}:trigger`}
              onPress={toggle}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              expanded={isOpen}
              hasPopup="menu"
            >
              <HappierFieldBoxTrigger
                colors={fieldColors}
                span="intrinsic"
                {...(selectedAgentId !== null ? { leading: <AgentMark agentId={selectedAgentId} size="xs" /> } : {})}
                trailing={
                  <Icon name={isOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                }
              >
                <Text style={fieldLabel.style} numberOfLines={1}>
                  {label}
                </Text>
              </HappierFieldBoxTrigger>
            </HappierPressable>
          )}
        />
      );
    },
    ConsequenceRow: ({ testID, continuesRow, showDivider, children }) => (
      <SectionContentRow testID={testID} showDivider={showDivider} continuesRow={continuesRow}>
        {children}
      </SectionContentRow>
    ),
    ErrorLine: ({ testID, title, diagnostic, actionLabel, onAction }) => (
      <SurfaceStateCard
        testID={testID}
        kind="error"
        size="line"
        title={title}
        diagnosticCode={diagnostic}
        action={{ label: actionLabel, onPress: onAction }}
      />
    ),
    Text: ({ variant, tone, emphasis, tabular, hidden, style, testID, children }) => (
      <Text
        variant={variant}
        {...(emphasis !== undefined ? { emphasis } : {})}
        {...(testID !== undefined ? { testID } : {})}
        {...(hidden ? { 'aria-hidden': true } : {})}
        style={[{ color: tones[tone] }, tabular ? styles.tabular : null, style]}
      >
        {children}
      </Text>
    ),
    PlaceGlyph,
    AgentMark,
    AgentNames: ({ agentIds, machines, testID }) => <AgentNameRun agentIds={agentIds} machines={machines} testID={testID} />,
    hasAgentMark: (agentId) => identityById.has(agentId),
  };
}

export const WhereItsOnControl = React.memo(function WhereItsOnControl({ onUndo: _onUndo, ...props }: WhereItsOnControlProps) {
  const { theme } = useUnistyles();
  const agentIds = React.useMemo(
    () => collectHappierWhereItsOnAgentIds(props.places.agentIds, props.rules, props.projection),
    [props.places.agentIds, props.rules, props.projection],
  );
  const { names, identityById } = useWhereItsOnNames({
    agentIds,
    machines: props.places.machines,
    projects: props.places.projects,
  });
  const host = React.useMemo(() => buildHost(theme, identityById), [theme, identityById]);
  return (
    <HappierWhereItsOnControl
      {...props}
      names={names}
      labels={whereItsOnControlLabels}
      host={host}
      reach={whereItsOnReach}
      space={theme.space}
    />
  );
});

/**
 * Add flows before the item exists: a local draft that starts from the protocol's create-time default and the
 * create Action's `where` (undefined until the person changes the pick, then the last `replace`).
 */
export function useDraftReachRules(kind: 'skill' | 'mcp_server'): Readonly<{
  rules: ReachRulesV1;
  where: ReachRulesChangeV1 | undefined;
  onChange: WhereItsOnControlProps['onChange'];
}> {
  return useHappierWhereItsOnDraft(kind, whereItsOnReach);
}

const styles = StyleSheet.create(() => ({
  tabular: { fontVariant: ['tabular-nums'] },
}));
