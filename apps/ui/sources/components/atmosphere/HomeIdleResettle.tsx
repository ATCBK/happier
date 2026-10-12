import * as React from 'react';
import { useAtmosphereMoment } from './atmosphereMoments';
import { atmosphereResettleFact, useAtmosphereComposerEmpty } from './atmosphereStage';
import { useIdleResettle } from './homeAtmosphereMoments';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useHomeAtmosphereEditor } from './look/atmosphereEditor';
import { pictureStore } from './pictureStore';
import type { BuiltinPicture } from './pictureStore.types';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';

const ensurePicture = (picture: BuiltinPicture) => pictureStore.ensureBuiltin(picture);

/**
 * Home's idle resettle (plan UD-4), as a leaf: only it follows the composer, the Look editor and the
 * picture catalog, so none of them renders Home. Idle is an empty, unfocused composer and no send.
 */
export function HomeIdleResettle(props: Readonly<{
    /** The built-in picture Home shows, or null. */
    picture: string | null;
    focused: boolean;
    writing: boolean;
    sending: boolean;
}>) {
    const moment = useAtmosphereMoment('idleResettle');
    const empty = useAtmosphereComposerEmpty();
    const active = useHostActivelyViewed();
    const editor = useHomeAtmosphereEditor();
    const pictures = useAtmospherePictureCatalog();
    const idle = empty && !props.writing && !props.sending;
    const visible = props.focused && active;
    React.useEffect(() => {
        // A retained, unfocused Home in a split does not own the active Home's playback posture.
        if (!props.focused) return;
        atmosphereResettleFact.setPaused(!idle || !visible);
        return () => atmosphereResettleFact.setPaused(true);
    }, [idle, visible, props.focused]);
    useIdleResettle({
        enabled: moment.on,
        picture: props.picture,
        idle,
        visible,
        reducedMotion: moment.reducedMotion,
        editor,
        pictures,
        ensure: ensurePicture,
    });
    return null;
}
