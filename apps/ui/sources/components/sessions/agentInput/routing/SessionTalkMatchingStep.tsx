import * as React from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
  normalizeSessionListFilterV1,
  type SessionListFilterV1,
} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { buildSessionListFilterEditorLabels } from '@/components/sessions/shell/search/SessionListFilterControl';
import { SessionListFilterEditor } from '@/components/sessions/shell/search/SessionListFilterEditor';
import {
  removeUnavailableSessionListFilterSelections,
  type SessionListViewFilters,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import {
  fromStoredSessionListFilter,
  toStoredSessionListFilter,
} from '@/components/sessions/shell/search/storedSessionListFilter';
import { useSessionListFilterEditorOptions } from '@/components/sessions/shell/search/useSessionListFilterEditorOptions';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';

/**
 * Matching reads one Home's Sessions: the preview resolves on this session's Home (an empty Home list
 * matches nothing), never Runs. The editor hides "Started by" for Sessions, so it must not narrow either.
 */
export function createSessionTalkMatchingFilter(serverId: string): SessionListFilterV1 {
  return normalizeSessionListFilterV1({
    show: 'sessions',
    startedBy: ['you', 'agents', 'triggers'],
    homeServerIds: [serverId],
  });
}

/**
 * The To picker's Matching step: the Sessions list's own filter editor, inline in the same picker. The
 * footer says whom the filter reaches now (the Action's own preview); "Use these" keeps the filter as
 * the selector, never the rows it shows.
 */
export function SessionTalkMatchingStep(
  props: Readonly<{
    serverId: string;
    filter: SessionListFilterV1;
    onFilterChange: (next: SessionListFilterV1) => void;
    /** One line: whom it reaches now, or why that isn't known. */
    summary: string;
    canUse: boolean;
    onUse: () => void;
    onBack: () => void;
    /** The picker's frame; the editor scrolls inside it so the picker keeps its size. */
    frameHeight?: number;
  }>,
) {
  const { theme } = useUnistyles();
  const { onFilterChange, serverId } = props;
  const mounted = React.useMemo(() => [serverId], [serverId]);
  const fixedHomes = React.useMemo(() => new Set(mounted), [mounted]);
  const filters = React.useMemo(
    () => fromStoredSessionListFilter(props.filter, mounted),
    [mounted, props.filter],
  );
  const options = useSessionListFilterEditorOptions(
    mounted,
    filters.homeServerIds,
  );
  const latest = React.useRef(filters);
  latest.current = filters;
  const save = React.useCallback(
    (next: SessionListViewFilters) =>
      onFilterChange(toStoredSessionListFilter(next)),
    [onFilterChange],
  );
  const labels = React.useMemo(
    () => ({
      ...buildSessionListFilterEditorLabels(),
      done: t('session.participants.talk.useThese'),
    }),
    [],
  );
  const [backHeight, setBackHeight] = React.useState(0);
  const onBackLayout = React.useCallback((event: LayoutChangeEvent) => {
    setBackHeight(Math.ceil(event.nativeEvent.layout.height));
  }, []);

  return (
    <View testID="session-talk-matching">
      <View onLayout={onBackLayout}>
        <Item
          testID="session-talk-matching-back"
          rowRole="menu"
          showChevron={false}
          showDivider={false}
          icon={
            <Icon
              name="caret-left"
              size={AGENT_INPUT_MENU_ICON_SIZE_PX}
              color={theme.colors.text.secondary}
            />
          }
          title={t('common.back')}
          onPress={props.onBack}
        />
      </View>
      <SessionListFilterEditor
        {...options}
        filters={filters}
        includeInactive={false}
        inactiveVisibilityAvailable={false}
        fixedShow="sessions"
        fixedHomeServerIds={fixedHomes}
        labels={labels}
        updateFilters={save}
        removeAuthoritativelyDeletedSelections={(deleted) => {
          const next = removeUnavailableSessionListFilterSelections(
            latest.current,
            deleted,
          );
          if (next !== latest.current) save(next);
        }}
        setIncludeInactive={noop}
        setSource={(source) => save({ ...latest.current, source })}
        resetFilters={() =>
          onFilterChange(createSessionTalkMatchingFilter(serverId))
        }
        resultSummary={props.summary}
        onDone={props.onUse}
        doneDisabled={!props.canUse}
        maxHeight={
          props.frameHeight
            ? Math.max(0, props.frameHeight - backHeight)
            : undefined
        }
      />
    </View>
  );
}

function noop() {}
