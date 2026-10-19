import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } from './voiceSettingsDeclarations';

export function getVoiceLocalNeuralSttSettingRefs(settings: ReturnType<typeof useVoiceSttSettingRefs>) {
    return Object.entries(settings).filter(([id]) => id.startsWith('stt') && id !== 'sttProvider').map(([, setting]) => setting);
}

/** Shared recognizer rows retain the identity of the intent page that renders them. */
export function useVoiceSttSettingRefs() {
    return usePathname() === SETTINGS_ROUTES.voiceDictation
        ? VOICE_DICTATION_SETTINGS.settings : VOICE_CONVERSATIONS_SETTINGS.settings;
}
