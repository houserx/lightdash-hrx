// /projects/:projectUuid/alerting/rules: the Alert Rules list.
import { Button, Group } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useMemo, type FC } from 'react';
import { useNavigate, useParams } from 'react-router';
import MantineIcon from '../../../components/common/MantineIcon';
import { useSpaceSummaries } from '../../../hooks/useSpaces';
import { AlertRulesList } from '../components/AlertRulesList';
import { useAlertRules } from '../hooks';
import { alertingUrl } from '../utils';
import { AlertingPage } from './AlertingPage';

const AlertRulesPage: FC = () => {
    const { projectUuid = '' } = useParams<{ projectUuid: string }>();
    const navigate = useNavigate();
    const rules = useAlertRules(projectUuid);
    const spaces = useSpaceSummaries(projectUuid, true);
    const folders = useMemo(
        () => (spaces.data ?? []).map(({ uuid, name }) => ({ uuid, name })),
        [spaces.data],
    );

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="rules"
            isLoading={rules.isInitialLoading}
            error={rules.error}
        >
            <Group justify="flex-end">
                <Button
                    leftSection={<MantineIcon icon={IconPlus} />}
                    onClick={() =>
                        void navigate(alertingUrl(projectUuid, 'rules/new'))
                    }
                >
                    New rule
                </Button>
            </Group>
            <AlertRulesList
                rules={rules.data ?? []}
                spaces={folders}
                onOpenRule={(ruleUuid) =>
                    void navigate(alertingUrl(projectUuid, `rules/${ruleUuid}`))
                }
            />
        </AlertingPage>
    );
};

export default AlertRulesPage;
