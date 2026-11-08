// /projects/:projectUuid/alerting/notification-routes: the project's one
// Notification Routes tree. Save PUTs the whole tree; a refused save shows
// the API's error and keeps the edits unsaved in the editor.
import { type NotificationRouteTree } from '@lightdash/common';
import { type FC } from 'react';
import { useParams } from 'react-router';
import useToaster from '../../../hooks/toaster/useToaster';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { saveNotificationRoutes } from '../api';
import { NotificationRoutesEditor } from '../components/NotificationRoutesEditor';
import {
    apiErrorMessage,
    useAlertingMutation,
    useContactPoints,
    useNotificationRoutes,
} from '../hooks';
import { AlertingPage } from './AlertingPage';

const NotificationRoutesPage: FC = () => {
    const { projectUuid = '' } = useParams<{ projectUuid: string }>();
    const lightdashApi = useLightdashApi();
    const { showToastError, showToastSuccess } = useToaster();
    const routes = useNotificationRoutes(projectUuid);
    const contactPoints = useContactPoints(projectUuid);
    const save = useAlertingMutation(
        projectUuid,
        (tree: NotificationRouteTree) =>
            saveNotificationRoutes(projectUuid, tree, lightdashApi),
    );
    const queries = [routes, contactPoints];

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="notification-routes"
            isLoading={queries.some((query) => query.isInitialLoading)}
            error={queries.find((query) => query.error)?.error}
        >
            {routes.isSuccess && contactPoints.isSuccess && (
                <NotificationRoutesEditor
                    // The editor keeps a local copy: remount it on each load.
                    key={routes.dataUpdatedAt}
                    tree={routes.data}
                    contactPoints={contactPoints.data}
                    onSave={async (tree) => {
                        try {
                            await save.mutateAsync(tree);
                        } catch (e) {
                            showToastError({
                                title: 'Could not save the Notification Routes',
                                subtitle: apiErrorMessage(e),
                            });
                            throw e;
                        }
                        showToastSuccess({
                            title: 'Notification Routes saved',
                        });
                    }}
                />
            )}
        </AlertingPage>
    );
};

export default NotificationRoutesPage;
