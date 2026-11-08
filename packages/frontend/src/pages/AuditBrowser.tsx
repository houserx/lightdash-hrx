import { type ApiError } from '@lightdash/common';
import { Stack, Text, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { type FC } from 'react';
import ErrorState from '../components/common/ErrorState';
import Page from '../components/common/Page/Page';
import SuboptimalState from '../components/common/SuboptimalState/SuboptimalState';
import { AuditBrowser } from '../features/auditBrowser/components/AuditBrowser';
import { useAuditBrowserApi } from '../features/auditBrowser/hooks/useAuditBrowserApi';
import { useFederationAccess } from '../features/investigate/hooks/useFederationAccess';
import { useProjectUuid } from '../hooks/useProjectUuid';

/** The audit browser page of a federation project (ADR 0004, CONTRACTS §6). */
const AuditBrowserPage: FC = () => {
    const projectUuid = useProjectUuid();
    const access = useFederationAccess(projectUuid);
    const fetchPage = useAuditBrowserApi(projectUuid);

    let content;
    if (access.isInitialLoading) {
        content = <SuboptimalState title="Loading access…" loading />;
    } else if (access.error) {
        content = <ErrorState error={(access.error as ApiError).error} />;
    } else if (!access.data?.isFederation) {
        content = (
            <SuboptimalState
                icon={IconLock}
                title="No audit records here"
                description="The audit browser is only available on Federation Engine projects."
            />
        );
    } else {
        content = (
            <AuditBrowser
                canRead={access.data.attrs.platform_read}
                fetchPage={fetchPage}
            />
        );
    }

    return (
        <Page title="Audit browser" withFitContent withPaddedContent>
            <Stack gap="lg">
                <Stack gap={4}>
                    <Title order={3}>Audit browser</Title>
                    <Text c="dimmed" size="sm">
                        Audited Query and Write Mode executions on this project.
                    </Text>
                </Stack>
                {content}
            </Stack>
        </Page>
    );
};

export default AuditBrowserPage;
