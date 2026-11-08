// /projects/:projectUuid/alerting/contact-points/new and
// .../contact-points/:contactPointUuid: the Contact Point editor. Save
// creates or updates it, then returns to the list; a refused save shows the
// API's error and keeps the editor's input.
import { type CreateContactPoint } from '@lightdash/common';
import { type FC } from 'react';
import { useNavigate, useParams } from 'react-router';
import useToaster from '../../../hooks/toaster/useToaster';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { createContactPoint, updateContactPoint } from '../api';
import { ContactPointEditor } from '../components/ContactPointEditor';
import {
    apiErrorMessage,
    useAlertingMutation,
    useContactPoint,
} from '../hooks';
import { alertingUrl } from '../utils';
import { AlertingPage } from './AlertingPage';

const ContactPointEditPage: FC = () => {
    const { projectUuid = '', contactPointUuid } = useParams<{
        projectUuid: string;
        contactPointUuid: string;
    }>();
    const navigate = useNavigate();
    const lightdashApi = useLightdashApi();
    const { showToastError, showToastSuccess } = useToaster();
    const query = useContactPoint(projectUuid, contactPointUuid);
    const contactPoint = query.data;
    const save = useAlertingMutation(
        projectUuid,
        (body: Pick<CreateContactPoint, 'name' | 'integrations'>) =>
            contactPointUuid
                ? updateContactPoint(
                      projectUuid,
                      contactPointUuid,
                      body,
                      lightdashApi,
                  )
                : createContactPoint(projectUuid, body, lightdashApi),
    );
    const openList = () =>
        void navigate(alertingUrl(projectUuid, 'contact-points'));

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="contact-points"
            title={contactPoint?.name ?? 'New Contact Point'}
            isLoading={!!contactPointUuid && query.isInitialLoading}
            error={query.error}
        >
            {(!contactPointUuid || contactPoint) && (
                <ContactPointEditor
                    key={contactPoint?.updatedAt ?? 'new'}
                    contactPoint={contactPoint}
                    onSubmit={async (body) => {
                        try {
                            await save.mutateAsync(body);
                            showToastSuccess({ title: 'Contact Point saved' });
                            openList();
                        } catch (e) {
                            showToastError({
                                title: 'Could not save the Contact Point',
                                subtitle: apiErrorMessage(e),
                            });
                        }
                    }}
                    onCancel={openList}
                />
            )}
        </AlertingPage>
    );
};

export default ContactPointEditPage;
