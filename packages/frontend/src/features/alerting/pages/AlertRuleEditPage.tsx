// /projects/:projectUuid/alerting/rules/new and .../rules/:ruleUuid/edit:
// the rule editor. Save creates or patches the rule, then opens its page; a
// refused save shows the API's error and keeps the editor's input.
import { type AlertRuleDefinition } from '@lightdash/common';
import { useMemo, type FC } from 'react';
import { useNavigate, useParams } from 'react-router';
import useToaster from '../../../hooks/toaster/useToaster';
import { useSpaceSummaries } from '../../../hooks/useSpaces';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { createAlertRule, updateAlertRule } from '../api';
import { AlertRuleEditor } from '../components/AlertRuleEditor';
import { apiErrorMessage, useAlertingMutation, useAlertRule } from '../hooks';
import { alertingUrl } from '../utils';
import { AlertingPage } from './AlertingPage';

const AlertRuleEditPage: FC = () => {
    const { projectUuid = '', ruleUuid } = useParams<{
        projectUuid: string;
        ruleUuid: string;
    }>();
    const navigate = useNavigate();
    const lightdashApi = useLightdashApi();
    const { showToastError, showToastSuccess } = useToaster();
    const rule = useAlertRule(projectUuid, ruleUuid);
    const spaces = useSpaceSummaries(projectUuid, true);
    const folders = useMemo(
        () => (spaces.data ?? []).map(({ uuid, name }) => ({ uuid, name })),
        [spaces.data],
    );
    const save = useAlertingMutation(
        projectUuid,
        (definition: AlertRuleDefinition) =>
            ruleUuid
                ? updateAlertRule(
                      projectUuid,
                      ruleUuid,
                      definition,
                      lightdashApi,
                  )
                : createAlertRule(projectUuid, definition, lightdashApi),
    );
    const openRuleOrList = () =>
        void navigate(
            alertingUrl(projectUuid, ruleUuid ? `rules/${ruleUuid}` : 'rules'),
        );

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="rules"
            title={rule.data ? `Edit ${rule.data.name}` : 'New Alert Rule'}
            isLoading={!!ruleUuid && rule.isInitialLoading}
            error={rule.error}
        >
            {(!ruleUuid || rule.data) && (
                <AlertRuleEditor
                    key={rule.data?.version ?? 'new'}
                    rule={rule.data}
                    spaces={folders}
                    onSubmit={async (definition) => {
                        try {
                            const saved = await save.mutateAsync(definition);
                            showToastSuccess({ title: 'Alert Rule saved' });
                            void navigate(
                                alertingUrl(projectUuid, `rules/${saved.uuid}`),
                            );
                        } catch (e) {
                            showToastError({
                                title: 'Could not save the Alert Rule',
                                subtitle: apiErrorMessage(e),
                            });
                        }
                    }}
                    onCancel={openRuleOrList}
                />
            )}
        </AlertingPage>
    );
};

export default AlertRuleEditPage;
