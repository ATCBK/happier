import * as React from 'react';
import { Image } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

/**
 * The one mark of an ACP agent the Account defines: the registry's own icon when it came from a registry (the ACP
 * Registry publishes monochrome icons, so it takes the ink like every other mark), else the generic command-line
 * glyph, since a command agent has no brand of its own. Never a tile behind it.
 */
export const AcpAgentGlyph = React.memo(function AcpAgentGlyph(
  props: Readonly<{ iconUrl?: string | null; size?: number }>,
) {
  const { theme } = useUnistyles();
  const size = props.size ?? 18;
  const [failed, setFailed] = React.useState(false);
  if (props.iconUrl && !failed) {
    return (
      <Image
        source={{ uri: props.iconUrl }}
        style={{ width: size, height: size }}
        // The prop, not the style key: web drops `style.tintColor`, which left the mark black on dark.
        tintColor={theme.colors.text.primary}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <Icon name="hard-drives" size={size} color={theme.colors.text.secondary} />
  );
});

/** The same mark in a collection list's mark column. */
export function CustomAcpAgentMark(
  props: Readonly<{ iconUrl?: string | null; dimmed?: boolean }> = {},
) {
  return (
    <HappierCollectionListMark dimmed={props.dimmed}>
      <AcpAgentGlyph
        iconUrl={props.iconUrl ?? null}
        size={props.iconUrl ? 20 : 18}
      />
    </HappierCollectionListMark>
  );
}
