import * as z from 'zod/mini';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';
import { PluginConfigurationSettingFieldV2Schema } from '@happier-dev/protocol';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const fields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
    {
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string', minLength: 1 },
        required: true,
    },
    {
        id: 'enabled',
        title: 'Enabled',
        schema: { type: 'boolean' },
        default: false,
    },
    {
        id: 'region',
        title: 'Region',
        schema: { type: 'string', enum: ['eu', 'us'] },
        presentation: {
            control: 'select',
            options: [
                { value: 'eu', title: 'Europe' },
                { value: 'us', title: 'United States' },
            ],
        },
    },
    {
        id: 'clientSecret',
        title: 'Client secret',
        schema: { type: 'string', minLength: 1 },
        secret: true,
        required: true,
    },
]);

describe('ConnectedAccountConfigurationForm', () => {
    afterEach(async () => {
        const { clearActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        clearActiveUnsavedChangesGuard();
    });

    it('submits descriptor-derived values and only explicit secret replacements', async () => {
        const onSubmit = vi.fn(async () => {});
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ endpoint: 'https://old.example', enabled: false, region: 'eu' }}
                configuredSecretFieldIds={['clientSecret']}
                saving={false}
                onSubmit={onSubmit}
            />,
        )).tree;

        const endpoint = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:endpoint');
        const secret = tree.find((node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:clientSecret');
        const enabled = tree.findAllByType(Item).find((node) => node.props.title === 'Enabled');
        if (!enabled) throw new Error('Expected the enabled configuration row');
        const region = tree.find((node) => node.props.testID === 'connected-account-configuration:region');

        await act(async () => {
            endpoint.props.onChangeText('https://new.example');
            secret.props.onChangeText('replacement');
            enabled.props.rightElement.props.onValueChange(true);
            region.props.onSelect(JSON.stringify('us'));
        });

        const save = tree.find((node) => node.props.testID === 'connected-account-configuration:save');
        await pressTestInstanceAsync(save);

        expect(onSubmit).toHaveBeenCalledWith({
            values: {
                endpoint: 'https://new.example',
                enabled: true,
                region: 'us',
            },
            secretValues: { clientSecret: 'replacement' },
        });
    });

    it('renders schema-only scalar and array enum choices without duplicate presentation metadata', async () => {
        const schemaOnlyFields = z.array(PluginConfigurationSettingFieldV2Schema).parse([
            {
                id: 'tier',
                title: 'Tier',
                schema: { type: 'string', enum: ['free', 'pro'] },
                default: 'free',
            },
            {
                id: 'scopes',
                title: 'Scopes',
                schema: {
                    type: 'array',
                    items: { type: 'string', enum: ['read', 'write'] },
                },
                default: ['read'],
            },
        ]);
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={schemaOnlyFields}
                values={{}}
                configuredSecretFieldIds={[]}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        const tier = tree.find(
            (node) => node.props.testID === 'connected-account-configuration:tier',
        );
        expect(tier.props.items).toEqual([
            { id: JSON.stringify('free'), title: 'free', subtitle: undefined },
            { id: JSON.stringify('pro'), title: 'pro', subtitle: undefined },
        ]);
        const scopeChoices = tree.findAllByType(Item).filter(
            (node) => node.props.title === 'read' || node.props.title === 'write',
        );
        expect(scopeChoices.map((choice) => ({
            testID: choice.props.rightElement.props.testID,
            value: choice.props.rightElement.props.value,
        }))).toEqual([
            {
                testID: 'connected-account-configuration:scopes:\"read\"',
                value: true,
            },
            {
                testID: 'connected-account-configuration:scopes:\"write\"',
                value: false,
            },
        ]);
    });

    it('associates exact invalid configuration field errors with their controls', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ enabled: false, region: 'eu' }}
                configuredSecretFieldIds={[]}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await pressTestInstanceAsync(
            tree.find((node) => node.props.testID === 'connected-account-configuration:save'),
        );

        const endpoint = tree.find(
            (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:endpoint',
        );
        expect(endpoint.props.accessibilityLabel)
            .toBe('Endpoint: connectedServices.account.configurationInvalid');
        expect(endpoint.props.accessibilityHint)
            .toBe('connectedServices.account.configurationInvalid');
        const secretError = tree.find(
            (node) => node.props.testID === 'connected-account-configuration:clientSecret.error',
        );
        expect(secretError.props.accessibilityRole).toBe('alert');
        expect(secretError.props.accessibilityLiveRegion).toBe('polite');
    });

    it('registers an entered configuration secret with the shared shell-navigation guard', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const tree = (await renderScreen(
            <ConnectedAccountConfigurationForm
                title="Configuration"
                fields={fields}
                values={{ endpoint: 'https://old.example', enabled: false, region: 'eu' }}
                configuredSecretFieldIds={['clientSecret']}
                saving={false}
                onSubmit={vi.fn()}
            />,
        )).tree;

        await act(async () => {
            tree.find(
                (node) => node.type === ('TextInput' as never) && node.props.testID === 'connected-account-configuration:clientSecret',
            ).props.onChangeText('replacement-secret');
        });

        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
    });

    it('retains edited values and secrets through option/read refreshes until the caller retires the target revision', async () => {
        const { ConnectedAccountConfigurationForm } = await import('./ConnectedAccountConfigurationForm');
        const onSubmit = vi.fn();
        const initialValues = { endpoint: 'https://old.example', enabled: false, region: 'eu' };
        const form = (key: string, refreshed: boolean) => <ConnectedAccountConfigurationForm
            key={key}
            title="Configuration"
            fields={refreshed ? fields.map(field => field.id === 'region' ? {
                ...field, schema: { ...field.schema, enum: ['eu', 'us', 'ap'] },
                presentation: { ...field.presentation, options: [
                    ...field.presentation!.options!, { value: 'ap', title: 'Asia Pacific' },
                ] },
            } : field) : fields}
            values={refreshed ? { ...initialValues, endpoint: 'https://updated.example' } : initialValues}
            configuredSecretFieldIds={['clientSecret']}
            saving={false}
            onSubmit={onSubmit}
        />;
        const screen = await renderScreen(
            form('target:revision-1', false),
        );
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://unsaved.example');
            screen.changeTextByTestId('connected-account-configuration:clientSecret', 'replacement-secret');
        });
        await screen.update(form('target:revision-1', true));
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://unsaved.example');
        expect(screen.findHostByTestId('connected-account-configuration:clientSecret')?.props.value).toBe('replacement-secret');
        await act(async () => {
            screen.tree.find(node => node.props.testID === 'connected-account-configuration:region').props.onSelect(JSON.stringify('ap'));
        });
        await screen.pressByTestIdAsync('connected-account-configuration:save');
        expect(onSubmit).toHaveBeenCalledWith({ values: {
            endpoint: 'https://unsaved.example', enabled: false, region: 'ap',
        }, secretValues: { clientSecret: 'replacement-secret' } });
        // The controller keys this form by configuration target/revision. A real
        // retirement must still clear secrets and seed the new read values.
        await screen.update(form('target:revision-2', true));
        expect(screen.findHostByTestId('connected-account-configuration:clientSecret')?.props.value).toBe('');
        expect(screen.findHostByTestId('connected-account-configuration:endpoint')?.props.value).toBe('https://updated.example');
        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current ?? false).toBe(false);
    });
});
