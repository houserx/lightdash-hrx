// The Contact Point editor (ENG-1799): creates a Contact Point or edits an
// existing one. Secrets (the Slack webhook URL, the incident.io token, a
// webhook's Authorization header) are entered only as secret references,
// `{ secretRef: <name> }`, never inline; a value that isn't a secret name is
// refused. Presentational: Save hands { name, integrations } to onSubmit, a
// valid CreateContactPoint and UpdateContactPoint body. A managed Contact
// Point (uploaded as code) opens read-only.
import {
    type ContactPoint,
    type ContactPointIntegration,
    type ContactPointIntegrationType,
    type CreateContactPoint,
} from '@lightdash/common';
import {
    Alert,
    Button,
    Fieldset,
    Group,
    Select,
    Stack,
    Switch,
    Textarea,
    TextInput,
    Title,
} from '@mantine/core';
import { useForm, type FormErrors } from '@mantine/form';
import { randomId } from '@mantine/hooks';
import { useState, type FC } from 'react';
import { CONTACT_POINT_INTEGRATION_LABELS, isSecretRefName } from '../utils';
import { ManagedInGitBadge } from './AlertBadges';

type Props = {
    /** The Contact Point to edit; a new one when absent. */
    contactPoint?: ContactPoint;
    /** Called on Save with the name and integrations. */
    onSubmit: (
        contactPoint: Pick<CreateContactPoint, 'name' | 'integrations'>,
    ) => void | Promise<unknown>;
    onCancel?: () => void;
};

type IntegrationFormValues = {
    key: string;
    type: ContactPointIntegrationType;
    /** The secret reference: webhook URL, token or Authorization header. */
    secretRef: string;
    url: string;
    channel: string;
    title: string;
    text: string;
    addresses: string;
    maxAlerts: string;
    disableResolveMessage: boolean;
};

type FormValues = {
    name: string;
    integrations: IntegrationFormValues[];
};

const INTEGRATION_TYPES = Object.keys(
    CONTACT_POINT_INTEGRATION_LABELS,
) as ContactPointIntegrationType[];

const SECRET_LABELS: Partial<Record<ContactPointIntegrationType, string>> = {
    slack_webhook: 'Webhook URL secret reference',
    incident_io: 'Token secret reference',
    webhook: 'Authorization secret reference',
};

const SECRET_DESCRIPTION =
    'The name of the secret holding the value, e.g. slack-infra-alerts-webhook. Never paste the secret itself.';

const emptyIntegration = (
    type: ContactPointIntegrationType = 'slack_webhook',
): IntegrationFormValues => ({
    key: randomId(),
    type,
    secretRef: '',
    url: '',
    channel: '',
    title: '',
    text: '',
    addresses: '',
    maxAlerts: '',
    disableResolveMessage: false,
});

const toIntegrationFormValues = (
    integration: ContactPointIntegration,
): IntegrationFormValues => {
    const values = {
        ...emptyIntegration(integration.type),
        disableResolveMessage: integration.disableResolveMessage ?? false,
    };
    switch (integration.type) {
        case 'slack_webhook':
            return {
                ...values,
                secretRef: integration.url.secretRef,
                title: integration.title ?? '',
                text: integration.text ?? '',
            };
        case 'slack_app':
            return {
                ...values,
                channel: integration.channel,
                title: integration.title ?? '',
                text: integration.text ?? '',
            };
        case 'incident_io':
            return {
                ...values,
                url: integration.url,
                secretRef: integration.token.secretRef,
            };
        case 'email':
            return { ...values, addresses: integration.addresses.join('\n') };
        case 'webhook':
            return {
                ...values,
                url: integration.url,
                secretRef: integration.authorization?.secretRef ?? '',
                maxAlerts:
                    integration.maxAlerts === undefined
                        ? ''
                        : String(integration.maxAlerts),
            };
        default:
            return values;
    }
};

const toFormValues = (contactPoint: ContactPoint | undefined): FormValues => ({
    name: contactPoint?.name ?? '',
    integrations: contactPoint
        ? contactPoint.integrations.map(toIntegrationFormValues)
        : [emptyIntegration()],
});

const parseAddresses = (text: string): string[] =>
    text
        .split(/[\s,;]+/)
        .map((address) => address.trim())
        .filter((address) => address !== '');

const optional = (value: string): string | undefined =>
    value.trim() === '' ? undefined : value;

const toIntegration = (
    values: IntegrationFormValues,
): ContactPointIntegration => {
    const disableResolveMessage = values.disableResolveMessage
        ? { disableResolveMessage: true }
        : {};
    switch (values.type) {
        case 'slack_webhook':
            return {
                type: 'slack_webhook',
                url: { secretRef: values.secretRef.trim() },
                ...(optional(values.title) && { title: values.title }),
                ...(optional(values.text) && { text: values.text }),
                ...disableResolveMessage,
            };
        case 'slack_app':
            return {
                type: 'slack_app',
                channel: values.channel.trim(),
                ...(optional(values.title) && { title: values.title }),
                ...(optional(values.text) && { text: values.text }),
                ...disableResolveMessage,
            };
        case 'incident_io':
            return {
                type: 'incident_io',
                url: values.url.trim(),
                token: { secretRef: values.secretRef.trim() },
                ...disableResolveMessage,
            };
        case 'email':
            return {
                type: 'email',
                addresses: parseAddresses(values.addresses),
                ...disableResolveMessage,
            };
        case 'webhook':
        default:
            return {
                type: 'webhook',
                url: values.url.trim(),
                ...(optional(values.secretRef) && {
                    authorization: { secretRef: values.secretRef.trim() },
                }),
                ...(optional(values.maxAlerts) && {
                    maxAlerts: Number(values.maxAlerts.trim()),
                }),
                ...disableResolveMessage,
            };
    }
};

const isHttpUrl = (value: string): boolean => {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const integrationErrors = (
    values: IntegrationFormValues,
    path: string,
): FormErrors => {
    const errors: FormErrors = {};
    const secretLabel = SECRET_LABELS[values.type];
    const secret = values.secretRef.trim();
    if (secretLabel) {
        if (secret === '' && values.type !== 'webhook') {
            errors[`${path}.secretRef`] = `${secretLabel} is required`;
        } else if (secret !== '' && !isSecretRefName(secret)) {
            errors[`${path}.secretRef`] =
                'Enter the name of a secret (letters, digits, - _ .), not the secret itself';
        }
    }
    if (values.type === 'incident_io' || values.type === 'webhook') {
        if (!isHttpUrl(values.url.trim())) {
            errors[`${path}.url`] = 'URL must be an http(s) URL';
        }
    }
    if (values.type === 'slack_app' && values.channel.trim() === '') {
        errors[`${path}.channel`] = 'Channel is required';
    }
    if (values.type === 'email') {
        const addresses = parseAddresses(values.addresses);
        const bad = addresses.find((address) => !EMAIL.test(address));
        if (addresses.length === 0) {
            errors[`${path}.addresses`] = 'At least one address is required';
        } else if (bad) {
            errors[`${path}.addresses`] = `Not an email address: ${bad}`;
        }
    }
    if (
        values.type === 'webhook' &&
        values.maxAlerts.trim() !== '' &&
        !/^\d+$/.test(values.maxAlerts.trim())
    ) {
        errors[`${path}.maxAlerts`] =
            'Max alerts must be a whole number (0 for no limit)';
    }
    return errors;
};

const validate = (values: FormValues): FormErrors => ({
    ...(values.name.trim() === '' && { name: 'Name is required' }),
    ...values.integrations.reduce<FormErrors>(
        (errors, integration, i) => ({
            ...errors,
            ...integrationErrors(integration, `integrations.${i}`),
        }),
        {},
    ),
});

export const ContactPointEditor: FC<Props> = ({
    contactPoint,
    onSubmit,
    onCancel,
}) => {
    const [isSaving, setIsSaving] = useState(false);
    const form = useForm<FormValues>({
        initialValues: toFormValues(contactPoint),
        validate,
    });

    const readOnly = contactPoint?.managed === true;

    const handleSubmit = form.onSubmit(async (values) => {
        if (readOnly) return;
        setIsSaving(true);
        try {
            await onSubmit({
                name: values.name.trim(),
                integrations: values.integrations.map(toIntegration),
            });
        } finally {
            setIsSaving(false);
        }
    });

    return (
        <form onSubmit={handleSubmit} noValidate>
            <Stack gap="md">
                <Group gap="sm">
                    <Title order={2}>
                        {contactPoint
                            ? `Edit ${contactPoint.name}`
                            : 'New Contact Point'}
                    </Title>
                    {readOnly && <ManagedInGitBadge />}
                </Group>
                {readOnly && (
                    <Alert
                        color="violet"
                        title="This Contact Point is managed in git"
                    >
                        It was uploaded as code and can only be changed by
                        editing its file and uploading it again.
                    </Alert>
                )}
                <TextInput
                    disabled={readOnly}
                    label="Name"
                    description={
                        contactPoint
                            ? `Slug: ${contactPoint.slug} (Notification Routes refer to it)`
                            : 'The slug Notification Routes refer to is made from the name.'
                    }
                    {...form.getInputProps('name')}
                />
                {form.values.integrations.map((integration, i) => {
                    const path = `integrations.${i}`;
                    const secretLabel = SECRET_LABELS[integration.type];
                    const isSlack =
                        integration.type === 'slack_webhook' ||
                        integration.type === 'slack_app';
                    return (
                        <Fieldset
                            key={integration.key}
                            legend={`Integration ${i + 1}`}
                            disabled={readOnly}
                        >
                            <Stack gap="sm">
                                <Select
                                    disabled={readOnly}
                                    label="Integration type"
                                    allowDeselect={false}
                                    data={INTEGRATION_TYPES.map((type) => ({
                                        value: type,
                                        label: CONTACT_POINT_INTEGRATION_LABELS[
                                            type
                                        ],
                                    }))}
                                    {...form.getInputProps(`${path}.type`)}
                                />
                                {(integration.type === 'incident_io' ||
                                    integration.type === 'webhook') && (
                                    <TextInput
                                        disabled={readOnly}
                                        label="URL"
                                        placeholder="https://"
                                        {...form.getInputProps(`${path}.url`)}
                                    />
                                )}
                                {secretLabel && (
                                    <TextInput
                                        disabled={readOnly}
                                        label={secretLabel}
                                        description={
                                            integration.type === 'webhook'
                                                ? `Optional. ${SECRET_DESCRIPTION}`
                                                : SECRET_DESCRIPTION
                                        }
                                        autoComplete="off"
                                        {...form.getInputProps(
                                            `${path}.secretRef`,
                                        )}
                                    />
                                )}
                                {integration.type === 'slack_app' && (
                                    <TextInput
                                        disabled={readOnly}
                                        label="Channel"
                                        placeholder="#infra-alerts"
                                        {...form.getInputProps(
                                            `${path}.channel`,
                                        )}
                                    />
                                )}
                                {integration.type === 'email' && (
                                    <Textarea
                                        disabled={readOnly}
                                        label="Addresses"
                                        description="One per line, or separated by commas."
                                        autosize
                                        minRows={2}
                                        {...form.getInputProps(
                                            `${path}.addresses`,
                                        )}
                                    />
                                )}
                                {integration.type === 'webhook' && (
                                    <TextInput
                                        disabled={readOnly}
                                        label="Max alerts"
                                        description="Alerts per message; blank or 0 for no limit."
                                        inputMode="numeric"
                                        {...form.getInputProps(
                                            `${path}.maxAlerts`,
                                        )}
                                    />
                                )}
                                {isSlack && (
                                    <>
                                        <Textarea
                                            disabled={readOnly}
                                            label="Title"
                                            description="Optional template; the default Grafana title when blank."
                                            autosize
                                            minRows={1}
                                            {...form.getInputProps(
                                                `${path}.title`,
                                            )}
                                        />
                                        <Textarea
                                            disabled={readOnly}
                                            label="Text"
                                            description="Optional template; the default Grafana message when blank."
                                            autosize
                                            minRows={2}
                                            {...form.getInputProps(
                                                `${path}.text`,
                                            )}
                                        />
                                    </>
                                )}
                                <Group justify="space-between">
                                    <Switch
                                        disabled={readOnly}
                                        label="Don't send resolved notifications"
                                        {...form.getInputProps(
                                            `${path}.disableResolveMessage`,
                                            { type: 'checkbox' },
                                        )}
                                    />
                                    {!readOnly &&
                                        form.values.integrations.length > 1 && (
                                            <Button
                                                variant="subtle"
                                                color="red"
                                                size="xs"
                                                onClick={() =>
                                                    form.removeListItem(
                                                        'integrations',
                                                        i,
                                                    )
                                                }
                                            >
                                                Remove integration
                                            </Button>
                                        )}
                                </Group>
                            </Stack>
                        </Fieldset>
                    );
                })}
                {!readOnly && (
                    <Group>
                        <Button
                            variant="default"
                            size="xs"
                            onClick={() =>
                                form.insertListItem(
                                    'integrations',
                                    emptyIntegration(),
                                )
                            }
                        >
                            Add integration
                        </Button>
                    </Group>
                )}
                <Group justify="flex-end">
                    {onCancel && (
                        <Button variant="default" onClick={onCancel}>
                            Cancel
                        </Button>
                    )}
                    <Button
                        type="submit"
                        loading={isSaving}
                        disabled={readOnly}
                    >
                        Save
                    </Button>
                </Group>
            </Stack>
        </form>
    );
};
