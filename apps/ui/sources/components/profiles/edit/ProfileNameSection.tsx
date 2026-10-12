import * as React from 'react';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/**
 * A profile's name (and, for launch profiles that have one, its description) as page field rows: the
 * name is a short field beside its label (beneath it on phones), the description a stacked multiline
 * field, as in every creation form.
 */
export function ProfileNameSection(props: Readonly<{
    testIDPrefix: string;
    name: string;
    onChangeName: (name: string) => void;
    description?: Readonly<{ value: string; onChange: (description: string) => void }>;
}>) {
    return (
        <ItemGroup title={t(props.description ? 'common.details' : 'profiles.profileName')}>
            <Item
                title={t('common.name')}
                accessoryLayout="adaptive"
                showChevron={false}
                rightElement={(
                    <FieldTextInput
                        testID={`${props.testIDPrefix}-name`}
                        value={props.name}
                        onChangeText={props.onChangeName}
                        accessibilityLabel={t('common.name')}
                        placeholder={t('profiles.enterName')}
                        autoCapitalize="words"
                    />
                )}
            />
            {props.description ? (
                <Item
                    title={t('profilesPage.descriptionTitle')}
                    subtitle={t('profilesPage.descriptionHint')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID={`${props.testIDPrefix}-description`}
                            value={props.description.value}
                            onChangeText={props.description.onChange}
                            accessibilityLabel={t('profilesPage.descriptionTitle')}
                            multiline
                            minLines={2}
                            autoCapitalize="sentences"
                        />
                    )}
                />
            ) : null}
        </ItemGroup>
    );
}
