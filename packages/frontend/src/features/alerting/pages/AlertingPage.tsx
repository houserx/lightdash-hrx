// The frame every alerting page shares (ENG-1799): the page title, tabs for
// Alert Rules, Contact Points and Notification Routes, and the loading and
// error states of the page's queries.
import { Alert, Center, Loader, Stack, Tabs, Title } from '@mantine/core';
import { type FC, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import Page from '../../../components/common/Page/Page';
import { apiErrorMessage } from '../hooks';
import { alertingUrl } from '../utils';

export type AlertingSection =
    | 'rules'
    | 'contact-points'
    | 'notification-routes';

const SECTIONS: Record<AlertingSection, string> = {
    rules: 'Alert Rules',
    'contact-points': 'Contact Points',
    'notification-routes': 'Notification Routes',
};

type Props = {
    projectUuid: string;
    section: AlertingSection;
    /** The browser tab title; the section name when absent. */
    title?: string;
    /** Shows a loader instead of the children. */
    isLoading?: boolean;
    /** The first failed query's error, shown instead of the children. */
    error?: unknown;
    children?: ReactNode;
};

export const AlertingPage: FC<Props> = ({
    projectUuid,
    section,
    title,
    isLoading = false,
    error,
    children,
}) => {
    const navigate = useNavigate();

    let content: ReactNode = children;
    if (error) {
        content = (
            <Alert color="red" title="Could not load alerting data">
                {apiErrorMessage(error)}
            </Alert>
        );
    } else if (isLoading) {
        content = (
            <Center py="xl">
                <Loader color="gray" />
            </Center>
        );
    }

    return (
        <Page
            title={title ?? SECTIONS[section]}
            withCenteredRoot
            withCenteredContent
            withXLargePaddedContent
            withLargeContent
        >
            <Stack gap="lg">
                <Title order={3}>Alerting</Title>
                <Tabs
                    value={section}
                    onChange={(value) => {
                        if (value && value !== section) {
                            void navigate(alertingUrl(projectUuid, value));
                        }
                    }}
                >
                    <Tabs.List>
                        {Object.entries(SECTIONS).map(([value, label]) => (
                            <Tabs.Tab key={value} value={value}>
                                {label}
                            </Tabs.Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
                {content}
            </Stack>
        </Page>
    );
};
