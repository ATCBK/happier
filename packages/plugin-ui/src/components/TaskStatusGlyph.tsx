import type { ReactElement } from 'react';
import { View } from 'react-native';
import { Circle, Path, Svg } from 'react-native-svg';

import {
  resolveHappierIconSize,
  type HappierIconSize,
} from '../presentation/content/Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

/**
 * The five shared task status categories (a tracker's own workflow maps onto them: Linear's "In Review" is started,
 * GitHub's "Close as not planned" is canceled). Sources and pages never add a sixth.
 */
export type TaskStatusCategory =
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

export type TaskStatusGlyphProps = Readonly<{
  category: TaskStatusCategory;
  size?: HappierIconSize;
  /** Names the glyph when nothing beside it says the status; otherwise it is hidden from assistive technology. */
  accessibilityLabel?: string;
  testID?: string;
}>;

/**
 * A task's status category as a mark: the shape carries the category, never colour alone (a dashed ring for backlog,
 * a ring for to do, a half-filled ring for in progress, a filled check for done, a quiet filled cross for canceled).
 * Glyphs are ink; only done is green. Used wherever a task's category is drawn (rows, the detail's status control,
 * relation rows, a Work Board card) so one task reads the same everywhere.
 */
export function TaskStatusGlyph({
  category,
  size = 'small',
  accessibilityLabel,
  testID,
}: TaskStatusGlyphProps): ReactElement {
  const theme = usePluginTheme();
  const pixels = resolveHappierIconSize(size);
  const ink =
    category === 'completed'
      ? theme.colors.success
      : category === 'canceled' || category === 'backlog'
        ? theme.colors.mutedText
        : theme.colors.secondaryText;
  const paper = theme.colors.surface;
  return (
    <View
      role={accessibilityLabel ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={accessibilityLabel ? undefined : true}
      testID={testID}
      style={{ width: pixels, height: pixels }}
    >
      <Svg width={pixels} height={pixels} viewBox="0 0 24 24" fill="none">
        {category === 'completed' || category === 'canceled' ? (
          <>
            <Circle cx={12} cy={12} r={8.6} fill={ink} />
            <Path
              d={
                category === 'completed'
                  ? 'm8.4 12.2 2.4 2.4 4.8-4.9'
                  : 'm9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6'
              }
              stroke={paper}
              strokeWidth={1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <Circle
              cx={12}
              cy={12}
              r={8}
              stroke={ink}
              strokeWidth={1.8}
              {...(category === 'backlog'
                ? { strokeDasharray: '2.6 2.4' }
                : {})}
            />
            {category === 'started' ? (
              <Path d="M12 7.2a4.8 4.8 0 0 1 0 9.6Z" fill={ink} />
            ) : null}
          </>
        )}
      </Svg>
    </View>
  );
}
