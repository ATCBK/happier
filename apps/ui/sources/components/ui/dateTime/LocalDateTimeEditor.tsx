import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
    HappierLocalDateTimeField,
    type HappierLocalDateTimeFieldProps,
    type HappierLocalDateTimePickerHost,
    type HappierLocalDateTimePickerMode,
    type HappierLocalDateTimePickerRequest,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Icon } from '@/components/ui/icons/Icon';

import { DateTimePickerPopover, isDateTimePickerPopoverAvailable } from './DateTimePickerPopover';

function PickerGlyph(props: Readonly<{ mode: HappierLocalDateTimePickerMode }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.mode === 'date' ? 'calendar' : 'clock'} size={18} color={theme.colors.text.secondary} />;
}

function AppDateTimePicker(props: HappierLocalDateTimePickerRequest) {
    const { theme } = useUnistyles();
    return <DateTimePickerPopover {...props} accentColor={theme.colors.text.link} />;
}

const APP_LOCAL_DATE_TIME_PICKER: HappierLocalDateTimePickerHost = Object.freeze({
    renderGlyph: (mode: HappierLocalDateTimePickerMode) => <PickerGlyph mode={mode} />,
    renderPicker: (request: HappierLocalDateTimePickerRequest) => <AppDateTimePicker {...request} />,
});

/**
 * The app's date and time picker for the public `HappierLocalDateTimeField`: the themed platform
 * picker when this binary has it, otherwise none and the field is typed alone. App screens and
 * plugin surfaces (through the private presentation host) share this one binding.
 */
export function resolveAppLocalDateTimePicker(): HappierLocalDateTimePickerHost | undefined {
    return isDateTimePickerPopoverAvailable() ? APP_LOCAL_DATE_TIME_PICKER : undefined;
}

/**
 * The public local date-time field in the app's theme with the app's picker. It binds only what is
 * app-private (the Unistyles theme and the platform picker); the field itself lives in plugin-ui.
 */
export function LocalDateTimeEditor(props: Omit<HappierLocalDateTimeFieldProps, 'theme' | 'picker'>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const picker = resolveAppLocalDateTimePicker();
    return <HappierLocalDateTimeField {...props} theme={presentationTheme} {...(picker ? { picker } : {})} />;
}
