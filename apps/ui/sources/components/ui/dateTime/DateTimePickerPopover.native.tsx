import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { Platform, TurboModuleRegistry, UIManager, View } from 'react-native';
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker';

import type { DateTimePickerPopoverProps } from './DateTimePickerPopover';

const DateTimePicker = retryableLazy(() => import('@react-native-community/datetimepicker'));

export function isDateTimePickerPopoverAvailable(): boolean {
    if (Platform.OS === 'ios') return UIManager.hasViewManagerConfig('RNDateTimePicker');
    if (Platform.OS === 'android') {
        // SDK 9.1.0 eagerly loads all four Android bindings, even for the regular picker.
        return ['RNCDatePicker', 'RNCTimePicker', 'RNCMaterialDatePicker', 'RNCMaterialTimePicker']
            .every((name) => TurboModuleRegistry.get(name) !== null);
    }
    return false;
}

export function DateTimePickerPopover(props: DateTimePickerPopoverProps) {
    if (!isDateTimePickerPopoverAvailable()) return null;
    return <View testID={`date-time-picker-${props.mode}-picker`} style={{ alignItems: 'center' }}>
        <React.Suspense fallback={null}>
            <DateTimePicker
                value={props.value}
                mode={props.mode}
                display={Platform.OS === 'ios' ? (props.mode === 'date' ? 'inline' : 'spinner') : (props.mode === 'date' ? 'calendar' : 'clock')}
                minimumDate={props.mode === 'date' ? props.minimumDate : undefined}
                accentColor={props.accentColor}
                onChange={(event: DateTimePickerEvent, value?: Date) => {
                    if (event.type === 'dismissed') { props.onDismiss(); return; }
                    if (value) props.onChange(value);
                    if (Platform.OS === 'android') props.onDismiss();
                }}
            />
        </React.Suspense>
    </View>;
}
