import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSetting } from '@/sync/store/hooks';

/** The Home atmosphere's moments, as its default map declares them. */
export type AtmosphereMomentId = keyof typeof DEFAULT_HOME_ATMOSPHERE.moments;

/** A moment missing from the stored map is on: the defaults turn every moment on. */
export function isAtmosphereMomentOn(moments: Readonly<Record<string, boolean>>, id: AtmosphereMomentId): boolean {
    return moments[id] ?? DEFAULT_HOME_ATMOSPHERE.moments[id] ?? true;
}

/** The account's stored switches, read where no component subscribes (a catalog projection, an Action). */
export function readAtmosphereMoments(): Readonly<Record<string, boolean>> {
    return getStorage().getState().settings?.homeAtmosphere?.moments ?? DEFAULT_HOME_ATMOSPHERE.moments;
}

/** The stored switches for a mounted consumer that projects several moments at once. */
export function useAtmosphereMoments(): Readonly<Record<string, boolean>> {
    return useSetting('homeAtmosphere').moments;
}

/**
 * Whether a moment plays, and whether it plays its reduced-motion path. Moments are always Home's
 * (projects inherit them), so every surface reads the one account switch.
 */
export function useAtmosphereMoment(id: AtmosphereMomentId): Readonly<{ on: boolean; reducedMotion: boolean }> {
    const on = isAtmosphereMomentOn(useSetting('homeAtmosphere').moments, id);
    const reducedMotion = useReducedMotionPreference();
    return { on, reducedMotion };
}
