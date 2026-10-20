import * as React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

import { isMachinePageTabRoot, type MachinePageTabParams } from './machinePageTabQuery';

/**
 * Which page of the machine page the params name, for its scroll: a tab's root, or a page it pushes (a kind, one
 * process, Activity). View state of the same page (a sort, a filter, Happier | Whole disk) is not a new page.
 */
export function machinePageScrollKey(params: MachinePageTabParams): string {
    const page = 'page' in params ? params.page ?? '' : '';
    const subject = params.id === 'storage' ? params.categoryId ?? ''
        : params.id === 'processes' ? params.owner ?? params.process ?? '' : '';
    return `${params.id}|${page}|${subject}`;
}

/**
 * The machine page's one scroller is shared by every tab and every page a tab pushes. A pushed page opens at its
 * top (it never inherits the tab's offset, FA1 #9); going back to a tab's root returns where it was left.
 */
export function createMachinePageScrollMemory() {
    const offsets = new Map<string, number>();
    return {
        record(key: string, offset: number) {
            offsets.set(key, offset);
        },
        /** The offset the page arrives at. */
        arrive(params: MachinePageTabParams): number {
            return isMachinePageTabRoot(params) ? offsets.get(machinePageScrollKey(params)) ?? 0 : 0;
        },
    };
}

/** Binds the scroll memory to the page's `ItemList`: records the offset per page, moves it when the page changes. */
export function useMachinePageScroll(params: MachinePageTabParams) {
    const ref = React.useRef<ScrollView>(null);
    const [memory] = React.useState(createMachinePageScrollMemory);
    const key = machinePageScrollKey(params);
    const current = React.useRef(key);
    const paramsRef = React.useRef(params);
    paramsRef.current = params;
    React.useLayoutEffect(() => {
        if (current.current === key) return;
        current.current = key;
        ref.current?.scrollTo({ y: memory.arrive(paramsRef.current), animated: false });
    }, [key, memory]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        memory.record(current.current, event.nativeEvent.contentOffset.y);
    }, [memory]);
    return { ref, onScroll };
}
