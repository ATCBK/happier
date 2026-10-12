/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { resolveWidgetBindingsV1 } from '@happier-dev/protocol/widgets';
import type { WidgetSetup } from './widgetSetupModel';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { WidgetSetupStep } from './WidgetSetupStep';
import { WidgetAddPanel, WidgetAddSurface } from './WidgetAddSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('opens the Machine choices of a widget when its trigger is clicked, for a Home with many near-identical machines', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const options = Array.from({ length: 86 }, (_, index) => ({
        value: { serverId: 'home', machineId: `machine-${index}` }, label: `lima-happier-fresh · ${index.toString(16).padStart(4, '0')}`,
        description: index === 0 ? 'Online' : 'Offline',
    }));
    const fields = [{ field: { path: 'machine', title: 'Machine', widget: 'select' as const, required: true,
        inputType: { hostType: 'machine' as const }, options } }];
    const setup: WidgetSetup = {
        title: 'Vitals', submitLabel: 'Add', initial: { bindings: {} }, fields,
        resolve: draft => resolveWidgetBindingsV1({ instance: { v: 1, id: 'preview',
            definition: { kind: 'builtin', id: 'machine_vitals' }, bindings: draft.bindings },
            fields: fields.map(entry => entry.field), context: {}, viewerValues: {}, validateValue: () => ({ status: 'valid' }) }),
        submit: async () => ({ ok: true }),
    };
    try {
        await act(async () => root.render(<WidgetSetupStep setup={setup} phone={false} onDone={() => {}} testID="setup" />));
        const trigger = document.querySelector<HTMLElement>('[data-testid="setup.field.machine.control.trigger"]')!;
        expect(trigger).not.toBeNull();
        await act(async () => { trigger.click(); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(document.querySelector('[data-testid="setup.field.machine.option.0"]')).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('keeps the Machine choices open inside the Add panel while its gallery is rebuilt by live Home data', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const options = Array.from({ length: 86 }, (_, index) => ({
        value: { serverId: 'home', machineId: `machine-${index}` }, label: `lima-happier-fresh · ${index.toString(16).padStart(4, '0')}`,
    }));
    const fields = [{ field: { path: 'machine', title: 'Machine', widget: 'select' as const, required: true,
        inputType: { hostType: 'machine' as const }, options } }];
    const buildSetup = (): WidgetSetup => ({
        title: 'Vitals', submitLabel: 'Add', initial: { bindings: {} }, fields,
        resolve: draft => resolveWidgetBindingsV1({ instance: { v: 1, id: 'preview',
            definition: { kind: 'builtin', id: 'machine_vitals' }, bindings: draft.bindings },
            fields: fields.map(entry => entry.field), context: {}, viewerValues: {}, validateValue: () => ({ status: 'valid' }) }),
        submit: async () => ({ ok: true }),
    });
    // A fresh section tree per render, as the Home gallery produces while presence and inventory change.
    const render = () => <WidgetAddPanel title="Add widgets" searchPlaceholder="Search widgets" addLabel="Add"
        composition="split" onRequestClose={() => {}} testID="add"
        sections={[{ id: 'builtins', title: 'Built in', entries: [
            { id: 'vitals', title: 'Vitals', icon: 'chart-bar' as const, setup: buildSetup }] }]} />;
    try {
        await act(async () => root.render(render()));
        await act(async () => { container.querySelector<HTMLElement>('[data-testid="add.entry.vitals"], [role="option"]')!.click(); });
        const trigger = document.querySelector<HTMLElement>('[data-testid$="field.machine.control.trigger"]')!;
        expect(trigger).not.toBeNull();
        await act(async () => { trigger.click(); });
        await act(async () => root.render(render()));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(document.querySelector('[data-testid$="field.machine.option.0"]')).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('opens the Machine choices of a widget inside the anchored Add popover of Home', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const options = Array.from({ length: 12 }, (_, index) => ({
        value: { serverId: 'home', machineId: `machine-${index}` }, label: `devbox · ${index}`,
    }));
    const fields = [{ field: { path: 'machine', title: 'Machine', widget: 'select' as const, required: true,
        inputType: { hostType: 'machine' as const }, options } }];
    const buildSetup = (): WidgetSetup => ({
        title: 'Vitals', submitLabel: 'Add', initial: { bindings: {} }, fields,
        resolve: draft => resolveWidgetBindingsV1({ instance: { v: 1, id: 'preview',
            definition: { kind: 'builtin', id: 'machine_vitals' }, bindings: draft.bindings },
            fields: fields.map(entry => entry.field), context: {}, viewerValues: {}, validateValue: () => ({ status: 'valid' }) }),
        submit: async () => ({ ok: true }),
    });
    const anchor = React.createRef<never>();
    const sections = [{ id: 'builtins', title: 'Built in', entries: [
        { id: 'vitals', title: 'Vitals', icon: 'chart-bar' as const, setup: buildSetup }] }];
    try {
        await act(async () => root.render(<>
            <button ref={anchor as never}>Customize</button>
            <WidgetAddSurface open anchorRef={anchor as never} title="Add widgets" searchPlaceholder="Search widgets"
                addLabel="Add" sections={sections} onRequestClose={() => {}} testID="add" />
        </>));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        await act(async () => { document.querySelector<HTMLElement>('[role="option"]')!.click(); });
        const trigger = document.querySelector<HTMLElement>('[data-testid$="field.machine.control.trigger"]')!;
        expect(trigger).not.toBeNull();
        await act(async () => { trigger.click(); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
        expect(document.querySelector('[data-testid$="field.machine.option.0"]')).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
