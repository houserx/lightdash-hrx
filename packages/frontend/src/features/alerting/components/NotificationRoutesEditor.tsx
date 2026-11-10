// The Notification Routes tree editor (ENG-1799): shows the project's tree,
// the default route and its child routes with their matchers, Contact Points
// and timers, and adds or removes top-level child routes. Presentational:
// Save hands the whole tree (a valid PUT /notification-routes body) to
// onSave. A managed tree (uploaded as code) opens read-only. The editor
// keeps its own copy of the tree: render it with a `key` that changes when a
// different tree is loaded.
import {
    ALERT_LABEL_MATCHER_OPERATORS,
    DEFAULT_ALERT_ROUTE_GROUP_INTERVAL,
    DEFAULT_ALERT_ROUTE_GROUP_WAIT,
    DEFAULT_ALERT_ROUTE_REPEAT_INTERVAL,
    getAlertLabelMatcherError,
    type AlertLabelMatcher,
    type AlertLabelMatcherOperator,
    type ContactPoint,
    type NotificationRoute,
    type NotificationRouteTree,
} from '@lightdash/common';
import {
    Alert,
    Badge,
    Box,
    Button,
    Code,
    Fieldset,
    Group,
    Paper,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Title,
} from '@mantine/core';
import { useForm, type FormErrors } from '@mantine/form';
import { randomId } from '@mantine/hooks';
import { useState, type FC } from 'react';
import { formatAlertLabelMatcher } from '../utils';
import { ManagedInGitBadge } from './AlertBadges';

type Props = {
    /** The saved tree; a new tree when absent or null. */
    tree?: (NotificationRouteTree & { managed?: boolean }) | null;
    /** Contact Points of the project; routes refer to them by slug. */
    contactPoints: ContactPoint[];
    /**
     * Called on Save with the whole tree. When it rejects, the edits stay
     * unsaved in the editor; the caller reports the error.
     */
    onSave: (tree: NotificationRouteTree) => void | Promise<unknown>;
};

type MatcherFormValues = {
    key: string;
    label: string;
    operator: AlertLabelMatcherOperator;
    value: string;
};

type RouteFormValues = {
    key: string;
    matchers: MatcherFormValues[];
    contactPoint: string | null;
    continue: boolean;
};

type FormValues = {
    contactPoint: string | null;
    newRoutes: RouteFormValues[];
};

const emptyMatcher = (): MatcherFormValues => ({
    key: randomId(),
    label: '',
    operator: '=',
    value: '',
});

const emptyRoute = (): RouteFormValues => ({
    key: randomId(),
    matchers: [emptyMatcher()],
    contactPoint: null,
    continue: false,
});

const toMatcher = ({
    label,
    operator,
    value,
}: MatcherFormValues): AlertLabelMatcher => ({
    label: label.trim(),
    operator,
    value,
});

const toRoute = (values: RouteFormValues): NotificationRoute => ({
    matchers: values.matchers.map(toMatcher),
    ...(values.contactPoint && { contactPoint: values.contactPoint }),
    ...(values.continue && { continue: true }),
});

const validate = (values: FormValues): FormErrors => {
    const errors: FormErrors = {};
    if (!values.contactPoint) {
        errors.contactPoint = 'The default route needs a Contact Point';
    }
    values.newRoutes.forEach((route, i) => {
        route.matchers.forEach((matcher, j) => {
            const path = `newRoutes.${i}.matchers.${j}`;
            if (matcher.label.trim() === '') {
                errors[`${path}.label`] = 'Label is required';
                return;
            }
            const error = getAlertLabelMatcherError(toMatcher(matcher));
            if (error) errors[`${path}.value`] = error;
        });
    });
    return errors;
};

const OPERATOR_OPTIONS = ALERT_LABEL_MATCHER_OPERATORS.map((operator) => ({
    value: operator,
    label: operator,
}));

const RouteSettings: FC<{ route: NotificationRoute }> = ({ route }) => {
    const settings = [
        route.groupBy &&
            `Group by ${
                route.groupBy.includes('...')
                    ? 'every label'
                    : route.groupBy.join(', ') || 'nothing'
            }`,
        route.groupWait && `Group wait ${route.groupWait}`,
        route.groupInterval && `Group interval ${route.groupInterval}`,
        route.repeatInterval && `Repeat interval ${route.repeatInterval}`,
    ].filter(Boolean);
    if (settings.length === 0) return null;
    return (
        <Text size="xs" c="dimmed">
            {settings.join(' · ')}
        </Text>
    );
};

const ChildRoute: FC<{
    route: NotificationRoute;
    contactPointName: (slug: string) => string;
    onRemove?: () => void;
}> = ({ route, contactPointName, onRemove }) => (
    <Paper withBorder p="sm" radius="sm">
        <Stack gap={6}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Group gap="xs">
                    {(route.matchers ?? []).length === 0 ? (
                        <Text size="sm" c="dimmed">
                            Matches every alert
                        </Text>
                    ) : (
                        (route.matchers ?? []).map((matcher, i) => (
                            <Code key={i}>
                                {formatAlertLabelMatcher(matcher)}
                            </Code>
                        ))
                    )}
                    {route.continue && (
                        <Badge size="sm" variant="light" color="gray">
                            Continue matching
                        </Badge>
                    )}
                </Group>
                {onRemove && (
                    <Button
                        variant="subtle"
                        color="red"
                        size="compact-xs"
                        onClick={onRemove}
                    >
                        Remove route
                    </Button>
                )}
            </Group>
            <Text size="sm">
                Contact point:{' '}
                {route.contactPoint ? (
                    <Text span fw={500}>
                        {contactPointName(route.contactPoint)}
                    </Text>
                ) : (
                    <Text span c="dimmed">
                        inherited
                    </Text>
                )}
            </Text>
            <RouteSettings route={route} />
            {(route.routes ?? []).length > 0 && (
                <Box pl="lg">
                    <Stack gap="xs">
                        {(route.routes ?? []).map((child, i) => (
                            <ChildRoute
                                key={child.id ?? i}
                                route={child}
                                contactPointName={contactPointName}
                            />
                        ))}
                    </Stack>
                </Box>
            )}
        </Stack>
    </Paper>
);

export const NotificationRoutesEditor: FC<Props> = ({
    tree,
    contactPoints,
    onSave,
}) => {
    const readOnly = tree?.managed === true;
    const [routes, setRoutes] = useState<NotificationRoute[]>(
        tree?.routes ?? [],
    );
    const [routesChanged, setRoutesChanged] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const form = useForm<FormValues>({
        initialValues: {
            contactPoint: tree?.contactPoint ?? null,
            newRoutes: [],
        },
        validate,
    });

    const contactPointName = (slug: string) =>
        contactPoints.find((cp) => cp.slug === slug)?.name ?? slug;
    const contactPointOptions = contactPoints.map((cp) => ({
        value: cp.slug,
        label: cp.name,
    }));

    const isChanged =
        form.values.newRoutes.length > 0 ||
        routesChanged ||
        form.values.contactPoint !== (tree?.contactPoint ?? null);

    const handleSubmit = form.onSubmit(async (values) => {
        if (readOnly || !values.contactPoint) return;
        const savedRoutes = [...routes, ...values.newRoutes.map(toRoute)];
        const saved: NotificationRouteTree = {
            contactPoint: values.contactPoint,
            ...(tree?.groupBy && { groupBy: tree.groupBy }),
            ...(tree?.groupWait && { groupWait: tree.groupWait }),
            ...(tree?.groupInterval && { groupInterval: tree.groupInterval }),
            ...(tree?.repeatInterval && {
                repeatInterval: tree.repeatInterval,
            }),
            routes: savedRoutes,
        };
        setIsSaving(true);
        try {
            await onSave(saved);
            setRoutes(savedRoutes);
            setRoutesChanged(false);
            form.setFieldValue('newRoutes', []);
        } catch {
            // A refused save keeps the edits unsaved; onSave reports why.
        } finally {
            setIsSaving(false);
        }
    });

    return (
        <form onSubmit={handleSubmit} noValidate>
            <Stack gap="md">
                <Group gap="sm">
                    <Title order={2}>Notification Routes</Title>
                    {readOnly && <ManagedInGitBadge />}
                </Group>
                {readOnly && (
                    <Alert
                        color="violet"
                        title="This route tree is managed in git"
                    >
                        It was uploaded as code and can only be changed by
                        editing its file and uploading it again.
                    </Alert>
                )}
                <Paper withBorder p="md" radius="sm">
                    <Stack gap="sm">
                        <Group gap="xs">
                            <Text fw={600}>Default route</Text>
                            <Text size="xs" c="dimmed">
                                Matches every alert no child route takes.
                            </Text>
                        </Group>
                        {readOnly ? (
                            <Text size="sm">
                                Contact point:{' '}
                                <Text span fw={500}>
                                    {form.values.contactPoint
                                        ? contactPointName(
                                              form.values.contactPoint,
                                          )
                                        : '–'}
                                </Text>
                            </Text>
                        ) : (
                            <Select
                                label="Default contact point"
                                allowDeselect={false}
                                searchable
                                data={contactPointOptions}
                                {...form.getInputProps('contactPoint')}
                            />
                        )}
                        <RouteSettings
                            route={{
                                groupBy: tree?.groupBy,
                                groupWait:
                                    tree?.groupWait ??
                                    DEFAULT_ALERT_ROUTE_GROUP_WAIT,
                                groupInterval:
                                    tree?.groupInterval ??
                                    DEFAULT_ALERT_ROUTE_GROUP_INTERVAL,
                                repeatInterval:
                                    tree?.repeatInterval ??
                                    DEFAULT_ALERT_ROUTE_REPEAT_INTERVAL,
                            }}
                        />
                        <Stack gap="xs" pl="lg">
                            {routes.length === 0 &&
                                form.values.newRoutes.length === 0 && (
                                    <Text size="sm" c="dimmed">
                                        No child routes: every alert goes to the
                                        default contact point.
                                    </Text>
                                )}
                            {routes.map((route, i) => (
                                <ChildRoute
                                    key={route.id ?? i}
                                    route={route}
                                    contactPointName={contactPointName}
                                    onRemove={
                                        readOnly
                                            ? undefined
                                            : () => {
                                                  setRoutes((current) =>
                                                      current.filter(
                                                          (_, j) => j !== i,
                                                      ),
                                                  );
                                                  setRoutesChanged(true);
                                              }
                                    }
                                />
                            ))}
                            {form.values.newRoutes.map((route, i) => (
                                <Fieldset
                                    key={route.key}
                                    legend={`New route ${i + 1}`}
                                >
                                    <Stack gap="sm">
                                        {route.matchers.map((matcher, j) => {
                                            const path = `newRoutes.${i}.matchers.${j}`;
                                            return (
                                                <Group
                                                    key={matcher.key}
                                                    align="flex-start"
                                                    wrap="nowrap"
                                                >
                                                    <TextInput
                                                        label="Label"
                                                        placeholder="team"
                                                        {...form.getInputProps(
                                                            `${path}.label`,
                                                        )}
                                                    />
                                                    <Select
                                                        label="Operator"
                                                        w={80}
                                                        allowDeselect={false}
                                                        data={OPERATOR_OPTIONS}
                                                        {...form.getInputProps(
                                                            `${path}.operator`,
                                                        )}
                                                    />
                                                    <TextInput
                                                        label="Value"
                                                        placeholder="infra"
                                                        {...form.getInputProps(
                                                            `${path}.value`,
                                                        )}
                                                    />
                                                    {route.matchers.length >
                                                        1 && (
                                                        <Button
                                                            mt={24}
                                                            variant="subtle"
                                                            color="red"
                                                            size="xs"
                                                            onClick={() =>
                                                                form.removeListItem(
                                                                    `newRoutes.${i}.matchers`,
                                                                    j,
                                                                )
                                                            }
                                                        >
                                                            Remove matcher
                                                        </Button>
                                                    )}
                                                </Group>
                                            );
                                        })}
                                        <Group>
                                            <Button
                                                variant="default"
                                                size="xs"
                                                onClick={() =>
                                                    form.insertListItem(
                                                        `newRoutes.${i}.matchers`,
                                                        emptyMatcher(),
                                                    )
                                                }
                                            >
                                                Add matcher
                                            </Button>
                                        </Group>
                                        <Select
                                            label="Contact point"
                                            description="Inherited from the default route when blank."
                                            clearable
                                            searchable
                                            data={contactPointOptions}
                                            {...form.getInputProps(
                                                `newRoutes.${i}.contactPoint`,
                                            )}
                                        />
                                        <Group justify="space-between">
                                            <Switch
                                                label="Continue matching sibling routes"
                                                {...form.getInputProps(
                                                    `newRoutes.${i}.continue`,
                                                    { type: 'checkbox' },
                                                )}
                                            />
                                            <Button
                                                variant="subtle"
                                                color="red"
                                                size="xs"
                                                onClick={() =>
                                                    form.removeListItem(
                                                        'newRoutes',
                                                        i,
                                                    )
                                                }
                                            >
                                                Discard route
                                            </Button>
                                        </Group>
                                    </Stack>
                                </Fieldset>
                            ))}
                        </Stack>
                        {!readOnly && (
                            <Group>
                                <Button
                                    variant="default"
                                    size="xs"
                                    onClick={() =>
                                        form.insertListItem(
                                            'newRoutes',
                                            emptyRoute(),
                                        )
                                    }
                                >
                                    Add route
                                </Button>
                            </Group>
                        )}
                    </Stack>
                </Paper>
                <Group justify="flex-end">
                    <Button
                        type="submit"
                        loading={isSaving}
                        disabled={readOnly || !isChanged}
                    >
                        Save
                    </Button>
                </Group>
            </Stack>
        </form>
    );
};
