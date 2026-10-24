import { Platform } from 'react-native';
import { DeviceType, deviceType } from 'expo-device';

import { isRunningOnMac } from './platform';
import { isWebMobileHost } from './webMobileHeuristics';

/** Hardware defaults stay stable when a desktop pane or native window resizes. */
export function isPhoneHardware(): boolean {
    if (Platform.OS === 'web') return isWebMobileHost();
    if (isRunningOnMac()) return false;
    return deviceType === DeviceType.PHONE;
}
