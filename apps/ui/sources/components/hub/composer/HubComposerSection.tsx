import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ComposerBannerCollapseProvider } from '@/components/sessions/composerBanners/ComposerBannerCollapseProvider';
import { NewSessionScreen } from '@/components/sessions/new/NewSessionScreen';
import { NewSessionEmbeddedHostProvider } from '@/components/sessions/new/navigation/newSessionHost';
import { useNewSessionEmbeddedHostState } from '@/components/sessions/new/navigation/useNewSessionEmbeddedHostState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { HubComposerSuggestions, type HomeComposerSuggestionFill } from './suggestions/HubComposerSuggestions';

/**
 * Home's "Start a session": the real New Session composer (the same surface and model as `/new`,
 * embedded through `NewSessionEmbeddedHostProvider`) at the page column's width, with suggestions
 * under it that fill it.
 *
 * Home starts on the ordinary-entry draft, the one "+" opens, so a draft begun in either place
 * continues in the other. Typing and Enter start the session here; the app then opens it, and the
 * next time Home is shown it holds a fresh draft.
 *
 * The composer's chips issue no machine RPCs until the person shows intent (focus, hover, touch or
 * a suggestion); until then they show cached state.
 */
export const HubComposerSection = React.memo(function HubComposerSection(props: Readonly<{
    /**
     * How the suggestions stand: `tiles` on the plain page; under Home's atmosphere they step back to
     * links or pills, wherever the composer sits (Home decides this once for both of its paths).
     */
    suggestions: 'tiles' | 'links' | 'pills';
    /**
     * `hero`: under Home's atmosphere the composer stands in the hero's own column (it supplies the
     * width and rhythm). Refs let the hero measure it.
     */
    hero?: Readonly<{
        composerRef: React.Ref<View>;
        suggestionsRef: React.Ref<View>;
        onLayout: () => void;
    }>;
}>) {
    const { host, markDemanded } = useNewSessionEmbeddedHostState();
    const draftId = typeof host.params.draftId === 'string' ? host.params.draftId : 'home-composer';
    const setHostParams = host.setParams;

    const fill = React.useCallback((suggestion: HomeComposerSuggestionFill) => {
        markDemanded();
        setHostParams({
            // The deep-link prompt param: an explicit fill that replaces what is typed, never a send.
            prompt: suggestion.prompt,
            ...(suggestion.placement
                ? {
                    spawnServerId: suggestion.placement.serverId ?? undefined,
                    machineId: suggestion.placement.machineId,
                    directory: suggestion.placement.directory,
                }
                : {}),
        });
    }, [markDemanded, setHostParams]);

    const hero = props.hero;
    const composer = (
        <View
            ref={hero?.composerRef}
            onLayout={hero?.onLayout}
            testID="hub-composer.intent"
            onFocus={markDemanded}
            onPointerEnter={markDemanded}
            onTouchStart={markDemanded}
        >
            <NewSessionEmbeddedHostProvider host={host}>
                <ComposerBannerCollapseProvider key={draftId}>
                    <NewSessionScreen presentation="embedded" />
                </ComposerBannerCollapseProvider>
            </NewSessionEmbeddedHostProvider>
        </View>
    );
    if (hero) {
        return (
            <View testID="hub-composer" style={styles.heroStack}>
                {composer}
                <View ref={hero.suggestionsRef} onLayout={hero.onLayout}>
                    <HubComposerSuggestions onFill={fill} presentation={props.suggestions} />
                </View>
            </View>
        );
    }
    return (
        <ItemGroup surface="none">
            <View testID="hub-composer" style={props.suggestions === 'tiles' ? styles.stack : styles.heroStack}>
                {composer}
                <HubComposerSuggestions onFill={fill} presentation={props.suggestions} />
            </View>
        </ItemGroup>
    );
});

const styles = StyleSheet.create(() => ({
    stack: {
        gap: 10,
    },
    // Lab `at-links`: the suggestions sit 12 px under the composer.
    heroStack: {
        gap: 12,
    },
}));
