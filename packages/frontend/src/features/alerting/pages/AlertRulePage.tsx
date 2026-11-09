// /projects/:projectUuid/alerting/rules/:ruleUuid: one rule with its query,
// state history and notifications, "Test rule" and Edit.
import { type FC } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { previewAlertRule } from '../api';
import { AlertRuleDetail } from '../components/AlertRuleDetail';
import {
    apiErrorMessage,
    toAlertRuleDefinition,
    useAlertRule,
    useAlertRuleHistory,
    useAlertRuleNotifications,
    useContactPoints,
} from '../hooks';
import { alertingUrl } from '../utils';
import { AlertingPage } from './AlertingPage';

const AlertRulePage: FC = () => {
    const { projectUuid = '', ruleUuid = '' } = useParams<{
        projectUuid: string;
        ruleUuid: string;
    }>();
    const navigate = useNavigate();
    const lightdashApi = useLightdashApi();
    const rule = useAlertRule(projectUuid, ruleUuid);
    const history = useAlertRuleHistory(projectUuid, ruleUuid);
    const notifications = useAlertRuleNotifications(projectUuid, ruleUuid);
    const contactPoints = useContactPoints(projectUuid);
    const queries = [rule, history, notifications];

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="rules"
            title={rule.data?.name}
            isLoading={queries.some((query) => query.isInitialLoading)}
            error={queries.find((query) => query.error)?.error}
        >
            {rule.data && (
                <AlertRuleDetail
                    rule={rule.data}
                    history={history.data ?? []}
                    notifications={notifications.data ?? []}
                    contactPoints={contactPoints.data ?? []}
                    onTestRule={async () => {
                        try {
                            return await previewAlertRule(
                                projectUuid,
                                toAlertRuleDefinition(rule.data),
                                lightdashApi,
                            );
                        } catch (e) {
                            // The detail page shows an Error's message.
                            throw new Error(apiErrorMessage(e));
                        }
                    }}
                    onEdit={() =>
                        void navigate(
                            alertingUrl(projectUuid, `rules/${ruleUuid}/edit`),
                        )
                    }
                />
            )}
        </AlertingPage>
    );
};

export default AlertRulePage;
