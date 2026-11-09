// /projects/:projectUuid/alerting/contact-points: the Contact Points list,
// with "Send test notification".
import { Button, Group } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { type FC } from 'react';
import { useNavigate, useParams } from 'react-router';
import MantineIcon from '../../../components/common/MantineIcon';
import { useLightdashApi } from '../../../providers/LightdashApi/useLightdashApi';
import { testContactPoint } from '../api';
import { ContactPointsList } from '../components/ContactPointsList';
import { useContactPoints } from '../hooks';
import { alertingUrl } from '../utils';
import { AlertingPage } from './AlertingPage';

const ContactPointsPage: FC = () => {
    const { projectUuid = '' } = useParams<{ projectUuid: string }>();
    const navigate = useNavigate();
    const lightdashApi = useLightdashApi();
    const contactPoints = useContactPoints(projectUuid);

    return (
        <AlertingPage
            projectUuid={projectUuid}
            section="contact-points"
            isLoading={contactPoints.isInitialLoading}
            error={contactPoints.error}
        >
            <Group justify="flex-end">
                <Button
                    leftSection={<MantineIcon icon={IconPlus} />}
                    onClick={() =>
                        void navigate(
                            alertingUrl(projectUuid, 'contact-points/new'),
                        )
                    }
                >
                    New contact point
                </Button>
            </Group>
            <ContactPointsList
                contactPoints={contactPoints.data ?? []}
                onSendTest={(contactPointUuid) =>
                    testContactPoint(
                        projectUuid,
                        contactPointUuid,
                        lightdashApi,
                    )
                }
                onOpen={(contactPointUuid) =>
                    void navigate(
                        alertingUrl(
                            projectUuid,
                            `contact-points/${contactPointUuid}`,
                        ),
                    )
                }
            />
        </AlertingPage>
    );
};

export default ContactPointsPage;
