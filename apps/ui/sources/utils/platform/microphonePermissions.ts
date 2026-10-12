import { Platform, Linking } from 'react-native';
import { Modal } from '@/modal';
import { AudioModule } from 'expo-audio';
import { t } from '@/text';

export interface MicrophonePermissionResult {
  granted: boolean;
  canAskAgain?: boolean;
  /** No microphone is connected: nothing was denied, and asking again cannot help until one is. */
  unavailable?: boolean;
}

/** The setup-facing reading of one permission result. */
export type MicrophonePermissionState = 'granted' | 'denied' | 'unavailable' | 'unknown';

export function readMicrophonePermissionState(result: MicrophonePermissionResult): MicrophonePermissionState {
  if (result.granted) return 'granted';
  if (result.unavailable === true) return 'unavailable';
  return result.canAskAgain === false ? 'denied' : 'unknown';
}

const MICROPHONE_UNAVAILABLE = 'mic_unavailable';

function readErrorName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { name?: unknown; code?: unknown };
  return typeof candidate.name === 'string' ? candidate.name : typeof candidate.code === 'string' ? candidate.code : '';
}

/** The platform found no microphone to open (or Voice already said so). */
export function isMicrophoneUnavailableError(error: unknown): boolean {
  const name = readErrorName(error);
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return true;
  return error instanceof Error && error.message === MICROPHONE_UNAVAILABLE;
}

/**
 * The one decision on a refused microphone request. A missing device fails as unavailable without
 * the permission recovery (nothing was denied); a denial presents the platform's recovery once.
 */
export function rejectRefusedMicrophone(
  permission: MicrophonePermissionResult,
  presentDenied: (canAskAgain: boolean) => void,
): void {
  if (permission.granted) return;
  if (permission.unavailable === true) throw new Error(MICROPHONE_UNAVAILABLE);
  presentDenied(permission.canAskAgain === true);
  throw new Error('mic_permission_denied');
}

export function isPermissionDeniedMicrophoneError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return true;
  }

  const code = typeof candidate.code === 'string' ? candidate.code : '';
  if (code === 'NotAllowedError' || code === 'PermissionDeniedError') {
    return true;
  }

  const message = typeof candidate.message === 'string'
    ? candidate.message.toLowerCase()
    : typeof error === 'string'
      ? error.toLowerCase()
      : '';
  return message.includes('permission_denied') || message.includes('permission denied');
}

/**
 * CRITICAL: Request microphone permissions BEFORE starting any audio session
 * Without this, first voice session WILL fail on iOS/Android
 *
 * Uses expo-audio (SDK 52+) - expo-av is deprecated
 */
export async function requestMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      // Web: Use navigator.mediaDevices API
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Important: Stop the stream immediately after getting permission
        stream.getTracks().forEach(track => track.stop());
        return { granted: true };
      } catch (error: any) {
        if (isMicrophoneUnavailableError(error)) return { granted: false, unavailable: true };
        // User denied permission or browser doesn't support getUserMedia
        console.error('Web microphone permission denied:', error);
        return { granted: false, canAskAgain: !isPermissionDeniedMicrophoneError(error) };
      }
    } else {
      // iOS and Android: Use expo-audio (SDK 52+)
      const result = await AudioModule.requestRecordingPermissionsAsync();

      if (result.granted) {
        return { granted: true, canAskAgain: result.canAskAgain };
      }

      return { granted: false, canAskAgain: result.canAskAgain };
    }
  } catch (error) {
    console.error('Error requesting microphone permission:', error);
    return { granted: false };
  }
}

/**
 * Check current microphone permission status without prompting
 */
export async function checkMicrophonePermission(): Promise<MicrophonePermissionResult> {
  try {
    if (Platform.OS === 'web') {
      // Web: Check permission status if available
      if ('permissions' in navigator && 'query' in navigator.permissions) {
        try {
          const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          return { granted: result.state === 'granted' };
        } catch {
          // Permission API not supported or microphone permission not queryable
          // We'll have to request to know
          return { granted: false, canAskAgain: true };
        }
      }
      return { granted: false, canAskAgain: true };
    } else {
      // iOS and Android: Use expo-audio (SDK 52+)
      const result = await AudioModule.getRecordingPermissionsAsync();
      return { granted: result.granted, canAskAgain: result.canAskAgain };
    }
  } catch (error) {
    console.error('Error checking microphone permission:', error);
    return { granted: false };
  }
}

/**
 * Show appropriate error message when permission is denied
 */
export function showMicrophonePermissionDeniedAlert(canAskAgain: boolean = false) {
  const title = t('modals.microphoneAccessRequiredTitle');
  const message = canAskAgain
    ? t('modals.microphoneAccessRequiredRequestPermission')
    : t('modals.microphoneAccessRequiredEnableInSettings');

  if (Platform.OS === 'web') {
    // Web: Show browser-specific instructions
    Modal.alert(
      title,
      t('modals.microphoneAccessRequiredBrowserInstructions'),
      [{ text: t('common.ok') }]
    );
  } else {
    Modal.alert(title, message, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('modals.openSettings'),
        onPress: () => {
          // Opens app settings on iOS/Android
          Linking.openSettings();
        }
      }
    ]);
  }
}
