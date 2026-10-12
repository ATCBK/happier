import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { transformSync } from '@babel/core';
import * as React from 'react';

const require = createRequire(import.meta.url);

function compile(filename: string, worklets: boolean): string {
    const result = transformSync(readFileSync(filename, 'utf8'), {
        filename,
        configFile: false,
        babelrc: false,
        plugins: [
            [require.resolve('@babel/plugin-transform-typescript'), { isTSX: filename.endsWith('.tsx') }],
            require.resolve('@babel/plugin-transform-react-jsx'),
            ...(worklets ? [require.resolve('react-native-worklets/plugin')] : []),
            require.resolve('@babel/plugin-transform-modules-commonjs'),
        ],
    });
    if (!result?.code) throw new Error(`No compiled module: ${filename}`);
    return result.code;
}

function evaluate<T>(code: string, dependencies: ReadonlyMap<string, unknown>, globals: object = Object.create(globalThis)): T {
    const exports = {};
    // This is compiled third-party/fixture code; the cast is confined to the module boundary.
    new Function('exports', 'require', 'global', code)(exports, (id: string) => {
        if (!dependencies.has(id)) throw new Error(`Missing module boundary: ${id}`);
        return dependencies.get(id);
    }, globals);
    return exports as T;
}

/** Compile the real component with the installed worklets plugin, rather than losing its closure in Vitest. */
export async function loadWorkletModule<T>(filename: string, overrides: ReadonlyMap<string, unknown> = new Map()): Promise<T> {
    const code = compile(filename, true);
    const dependencies = new Map(overrides);
    for (const match of code.matchAll(/require\("([^"]+)"\)/g)) {
        const id = match[1]!;
        if (dependencies.has(id)) continue;
        // Literal imports preserve Vitest's canonical boundary mocks in evaluated source modules.
        if (id === 'react-native-reanimated') {
            dependencies.set(id, await import('react-native-reanimated'));
            continue;
        }
        if (id === 'react-native') {
            dependencies.set(id, await import('react-native'));
            continue;
        }
        if (id === 'react-native-unistyles') {
            dependencies.set(id, await import('react-native-unistyles'));
            continue;
        }
        if (id === 'react-native-gesture-handler') {
            dependencies.set(id, await import('react-native-gesture-handler'));
            continue;
        }
        const specifier = id.startsWith('.') ? resolve(dirname(filename), id) : id;
        dependencies.set(id, await import(/* @vite-ignore */ specifier));
    }
    return evaluate<T>(code, dependencies);
}

type MapperModule = Readonly<{
    startMapper: (worklet: () => void, inputs: unknown[]) => number;
    stopMapper: (id: number) => void;
}>;
type CapturedUpdater<T> = (() => T) & Readonly<{ __closure?: Record<string, unknown>; __workletHash?: number }>;

/** Only scheduling and shared-value storage are substituted. Input extraction and mapper execution are real. */
export function createReanimatedMapperMock(onMapperLifecycle?: (event: 'start' | 'stop') => void) {
    const sourceRoot = resolve(dirname(require.resolve('react-native-reanimated/package.json')), 'src');
    const sharedValueModule = evaluate(compile(resolve(sourceRoot, 'isSharedValue.ts'), false), new Map());
    const mappers = evaluate<MapperModule>(compile(resolve(sourceRoot, 'mappers.ts'), false), new Map<string, unknown>([
        ['react-native-worklets', { scheduleOnUI: (worklet: () => void) => worklet() }],
        ['./common', { IS_JEST: true }],
        ['./isSharedValue', sharedValueModule],
    ]));

    function useSharedValue<T>(initial: T) {
        const ref = React.useRef<ReturnType<typeof makeSharedValue<T>> | null>(null);
        ref.current ??= makeSharedValue(initial);
        return ref.current;
    }

    function useAnimatedStyle<T extends object>(updater: CapturedUpdater<T>) {
        const style = React.useRef(updater());
        const inputs = Object.values(updater.__closure ?? {});
        React.useEffect(() => {
            const id = mappers.startMapper(() => Object.assign(style.current, updater()), inputs);
            onMapperLifecycle?.('start');
            return () => { mappers.stopMapper(id); onMapperLifecycle?.('stop'); };
        }, [...inputs, updater.__workletHash]);
        return style.current;
    }

    function useAnimatedReaction<T>(prepare: CapturedUpdater<T>, react: (next: T, previous: T | null) => void) {
        const inputs = Object.values(prepare.__closure ?? {});
        React.useEffect(() => {
            let previous: T | null = null;
            const id = mappers.startMapper(() => {
                const next = prepare();
                react(next, previous);
                previous = next;
            }, inputs);
            return () => mappers.stopMapper(id);
        }, inputs);
    }

    const View = 'AnimatedView';
    return {
        default: { View, createAnimatedComponent: (component: unknown) => component },
        useSharedValue,
        useAnimatedStyle,
        useAnimatedProps: useAnimatedStyle,
        useAnimatedReaction,
        withTiming: <T,>(to: T) => to,
        withSpring: <T,>(to: T) => to,
        cancelAnimation: () => {},
        Easing: { out: (curve: unknown) => curve, cubic: (value: number) => value },
    };
}

function makeSharedValue<T>(initial: T) {
    let current = initial;
    const listeners = new Map<number, () => void>();
    return {
        _isReanimatedSharedValue: true,
        get value() { return current; },
        set value(next: T) {
            if (Object.is(next, current)) return;
            current = next;
            for (const listener of listeners.values()) listener();
        },
        addListener: (id: number, listener: () => void) => { listeners.set(id, listener); },
        removeListener: (id: number) => { listeners.delete(id); },
        get: () => current,
        set: (next: T | ((value: T) => T)) => {
            current = typeof next === 'function' ? (next as (value: T) => T)(current) : next;
            for (const listener of listeners.values()) listener();
        },
        modify: () => {},
    };
}
