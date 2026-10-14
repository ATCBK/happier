import * as React from 'react';
import { View, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Typography } from '@/constants/Typography';
import { Pressable } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { toggleTodo, updateTodoTitle, deleteTodo } from '@/sync/domains/todos/todoOps';
import { useAuth } from '@/auth/context/AuthContext';
import { useShallow } from 'zustand/react/shallow';
import { clarifyPrompt } from '@/components/zen/workflow/clarifyPrompt';
import { projectTaskSessionLinks } from '@/sync/domains/todos/taskSessionLink';
import { t } from '@/text';
import { Text, TextInput } from '@/components/ui/text/Text';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { toCamelCase } from '@/utils/strings/stringUtils';
import { TaskSessionStatusPill, TaskStatusPill } from '@/components/zen/views/TaskSessionStatusPill';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerAccountScopesEqual, serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';


export const ZenView = React.memo(() => {
    const router = useRouter();
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const params = useLocalSearchParams();
    const auth = useAuth();

    const todoId = params.id as string;
    const taskScope = storage((state) => state.profileScope);

    // Get todo from storage
    const todo = storage(useShallow(state => {
        const todoState = state.todoState;
        if (!todoState) return null;
        const todoItem = todoState.todos[todoId];
        if (!todoItem) return null;
        return {
            id: todoItem.id,
            title: todoItem.title,
            done: todoItem.done,
            linkedSessions: todoItem.linkedSessions,
        };
    }));

    const [isEditing, setIsEditing] = React.useState(false);
    const [editedText, setEditedText] = React.useState(todo?.title || '');

    // Get linked sessions for this task
    const linkedSessions = React.useMemo(() => {
        return projectTaskSessionLinks(todo, taskScope);
    }, [todo, taskScope]);

    // Update local state when todo changes
    React.useEffect(() => {
        if (todo) {
            setEditedText(todo.title);
        }
    }, [todo?.title]);

    // Handle keyboard shortcut
    React.useEffect(() => {
        const handleKeyPress = (event: KeyboardEvent) => {
            // Navigate to new todo when any key is pressed (except when editing)
            if (!isEditing && event.key && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
                router.dismissAll();
                router.push('/zen/new');
            }
        };

        if (Platform.OS === 'web') {
            window.addEventListener('keypress', handleKeyPress);
            return () => window.removeEventListener('keypress', handleKeyPress);
        }
    }, [isEditing, router]);

    if (!todo) {
        // Todo was deleted or doesn't exist
        return null;
    }

    const handleSave = async () => {
        if (editedText.trim() && editedText !== todo.title && auth?.credentials) {
            await updateTodoTitle(auth.credentials, todoId, editedText.trim());
        }
        setIsEditing(false);
    };

    const handleToggleDone = async () => {
        if (auth?.credentials) {
            await toggleTodo(auth.credentials, todoId);
        }
    };

    const handleDelete = async () => {
        if (auth?.credentials) {
            // Remove any linked sessions
            await deleteTodo(auth.credentials, todoId);
            router.back();
        }
    };

    const openTaskSessionDraft = (prompt: string) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, taskScope)) return;
        seedAndOpenNewSession({
            scope: lifetime.scope,
            seed: { prompt },
            zenTaskSource: { kind: 'zen_task', taskId: todoId, title: editedText, scope: lifetime.scope },
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => {
                router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) });
            },
        });
    };

    const handleClarifyWithAI = () => {
        // Generate the task file name from the task title
        const taskFileName = toCamelCase(editedText) || 'untitledTask';
        const taskFile = `.dev/tasks/${taskFileName}.md`;

        // Format the prompt using the full clarifyPrompt template
        const promptText = clarifyPrompt
            .replace('{{taskFile}}', taskFile)
            .replace('{{task}}', editedText);

        openTaskSessionDraft(promptText);
    };

    const handleWorkOnTask = () => {
        openTaskSessionDraft(`Work on this task: ${editedText}`);
    };

    return (
        <KeyboardAwareScrollView
            style={styles.container}
            contentContainerStyle={{ flexGrow: 1 }}
            keyboardShouldPersistTaps="handled"
        >
                <View style={[
                    styles.content,
                    { paddingBottom: insets.bottom + 20 }
                ]}>
                    {/* Checkbox and Main Content */}
                    <View style={styles.mainSection}>
                        <Pressable
                            onPress={handleToggleDone}
                            style={[
                                styles.checkbox,
                                {
                                    borderColor: todo.done ? theme.colors.state.success.foreground : theme.colors.text.secondary,
                                    backgroundColor: todo.done ? theme.colors.state.success.foreground : 'transparent',
                                }
                            ]}
                        >
                            {todo.done && (
                                <Icon name="check" size={20} color={theme.colors.button.primary.tint} />
                            )}
                        </Pressable>

                        <View style={{ flex: 1 }}>
                            {isEditing ? (
                                <TextInput
                                    style={[
                                        styles.input,
                                        {
                                            color: theme.colors.text.primary,
                                            borderBottomColor: theme.colors.border.default,
                                        }
                                    ]}
                                    value={editedText}
                                    onChangeText={setEditedText}
                                    onBlur={handleSave}
                                    onSubmitEditing={handleSave}
                                    autoFocus
                                    multiline
                                    blurOnSubmit={true}
                                />
                            ) : (
                                <Pressable onPress={() => setIsEditing(true)}>
                                    <Text style={[
                                        styles.taskText,
                                        {
                                            color: todo.done ? theme.colors.text.secondary : theme.colors.text.primary,
                                            textDecorationLine: todo.done ? 'line-through' : 'none',
                                            opacity: todo.done ? 0.6 : 1,
                                        }
                                    ]}>
                                        {editedText}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </View>

                    {/* Actions */}
                    <View style={styles.actions}>
                        <RoundButtonSizeScope size="normal" presentation="uniform">
                            <RoundButton
                                size="normal"
                                title={t('zen.view.workOnTask')}
                                leading={<Icon name="hammer" size={18} color={theme.colors.button.primary.tint} />}
                                onPress={handleWorkOnTask}
                            />
                            <RoundButton
                                size="normal"
                                display="secondary"
                                title={t('zen.view.clarify')}
                                leading={<Icon name="sparkle" size={18} color={theme.colors.text.primary} />}
                                onPress={handleClarifyWithAI}
                            />
                            <RoundButton
                                size="normal"
                                display="destructive"
                                title={t('zen.view.delete')}
                                leading={<Icon name="trash" size={18} color={theme.colors.state.danger.foreground} />}
                                onPress={handleDelete}
                            />
                        </RoundButtonSizeScope>
                    </View>

                    {/* Linked Sessions */}
                    <TaskStatusPill taskId={todoId} />
                    {linkedSessions.length > 0 && (
                        <View style={styles.linkedSessionsSection}>
                            <Text style={[styles.sectionTitle, { color: theme.colors.text.primary }]}>
                                {t('zen.view.linkedSessions')}
                            </Text>
                            {linkedSessions.map((link, index) => (
                                <Pressable
                                    key={serverAccountScopedResourceKey(link, link.sessionId)}
                                    onPress={async () => {
                                        const target = await resolveServerCredentialAccountScope(link.serverId);
                                        if (target.kind !== 'bound' || !areServerAccountScopesEqual(target.scope, link)) return;
                                        router.dismissAll();
                                        router.push(buildScopedSessionRouteHref({ sessionId: link.sessionId, serverId: link.serverId }));
                                    }}
                                    style={[styles.linkedSession, { backgroundColor: theme.colors.surface.elevated }]}
                                >
                                    <Icon name="chat-circle" size={16} color={theme.colors.text.secondary} />
                                    <Text style={[styles.linkedSessionText, { color: theme.colors.text.primary }]}>
                                        {link.title}
                                    </Text>
                                    <TaskSessionStatusPill link={link} />
                                    <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
                                </Pressable>
                            ))}
                        </View>
                    )}

                    {/* Helper Text */}
                    <View style={styles.helperSection}>
                        <Text style={[styles.helperText, { color: theme.colors.text.secondary }]}>
                            {t('zen.view.tapTaskTextToEdit')}
                        </Text>
                    </View>
                </View>
        </KeyboardAwareScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    content: {
        flex: 1,
        padding: theme.space.s20,
    },
    mainSection: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: theme.space.s32,
    },
    checkbox: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: theme.space.s16,
        marginTop: theme.space.s4,
    },
    taskText: {
        ...Typography.variant('title', 'regular'),
    },
    input: {
        ...Typography.variant('title', 'regular'),
        borderBottomWidth: 1,
        paddingVertical: theme.space.s8,
        paddingHorizontal: theme.space.s4,
        minHeight: 60,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s12,
        marginTop: theme.space.s24,
    },
    helperSection: {
        marginTop: theme.space.s32,
        paddingTop: theme.space.s16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    helperText: {
        ...Typography.variant('reading'),
    },
    linkedSessionsSection: {
        marginTop: theme.space.s24,
        paddingTop: theme.space.s16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    sectionTitle: {
        ...Typography.variant('label', 'semiBold'),
        marginBottom: theme.space.s12,
    },
    linkedSession: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        borderRadius: 8,
        marginBottom: theme.space.s8,
        gap: theme.space.s8,
    },
    linkedSessionText: {
        flex: 1,
        ...Typography.variant('label', 'regular'),
    },
}));
