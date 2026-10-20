import type { HappierLocalDateTimePickerRequest } from '@happier-dev/plugin-ui/presentation';

export type DateTimePickerPopoverProps = HappierLocalDateTimePickerRequest & Readonly<{
    accentColor: string;
}>;

export function isDateTimePickerPopoverAvailable(): boolean { return false; }

export function DateTimePickerPopover(_props: DateTimePickerPopoverProps) { return null; }
