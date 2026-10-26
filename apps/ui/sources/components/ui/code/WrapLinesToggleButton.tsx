import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { useEffectiveDiffWrapLines } from './diff/diffPresentationStyle';

type ControlledWrapLinesProps = Readonly<{
    wrapLines: boolean;
    onChange: (wrapLines: boolean) => void;
}>;

type WrapLinesToggleButtonProps = ControlledWrapLinesProps | Readonly<{
    wrapLines?: never;
    onChange?: never;
}>;

const WrapLinesToggleSwitch = React.memo(({ wrapLines, onChange, disabled = false }: ControlledWrapLinesProps & { disabled?: boolean }) => {
    const label = t('settingsAppearance.wrapLinesInDiffs');

    return (
        <IconButton
            testID="code-wrap-lines-toggle"
            accessibilityLabel={label}
            tooltip={label}
            accessibilityRole="switch"
            checked={wrapLines}
            selected={wrapLines}
            disabled={disabled}
            iconName="arrow-elbow-down-left"
            iconSize={18}
            size={28}
            variant="plain"
            interactiveTargetGapPx={8}
            onPress={() => { if (!disabled) onChange(!wrapLines); }}
        />
    );
});

const AccountWrapLinesToggleButton = React.memo(() => {
    const [wrapLinesSetting, setWrapLines] = useSettingMutable('wrapLinesInDiffs');
    const phone = useSurfaceStateSize() === 'phone';
    const wrapLines = useEffectiveDiffWrapLines(wrapLinesSetting === true) === true;
    return <WrapLinesToggleSwitch wrapLines={wrapLines} onChange={setWrapLines} disabled={phone} />;
});

export const WrapLinesToggleButton = React.memo((props: WrapLinesToggleButtonProps) => (
    typeof props.wrapLines === 'boolean'
        ? <WrapLinesToggleSwitch wrapLines={props.wrapLines} onChange={props.onChange} />
        : <AccountWrapLinesToggleButton />
));

WrapLinesToggleButton.displayName = 'WrapLinesToggleButton';
