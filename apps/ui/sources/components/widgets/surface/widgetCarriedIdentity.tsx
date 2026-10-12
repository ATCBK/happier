import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/** A carried card's mark in the card's own icon family (lab wgdnd 1: the widget's glyph before its name). */
function CarriedMark(props: Readonly<{ name: IconName; size: number }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={props.size} color={theme.colors.text.secondary} />;
}

/**
 * What a carried widget or group says about itself while it is dragged, the same way a Session card
 * does (`EntityDragSourceDescription`): its mark, then one state line — a widget's source and the size
 * it keeps ("analytics replica · Small"), a group's kind and count ("Group · 2 widgets").
 */
export function useWidgetCarriedIdentity(input: Readonly<
    | { kind: 'widget'; mark: IconName; source?: string | null; size?: WidgetSizeV1 }
    | { kind: 'group'; mark: IconName; childCount: number }
>): Readonly<{ subtitle: string; renderMark: (size: number) => React.ReactNode }> {
    const mark = input.mark;
    const subtitle = input.kind === 'group'
        ? t('widgetFrame.groupWidgetCount', { count: input.childCount })
        : [input.source, input.size ? t(`widgetAdd.sizes.${input.size}`) : null].filter(Boolean).join(' · ');
    const renderMark = React.useCallback((size: number) => <CarriedMark name={mark} size={size} />, [mark]);
    return React.useMemo(() => ({ subtitle, renderMark }), [renderMark, subtitle]);
}
