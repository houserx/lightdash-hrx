// Contact Point API types (ENG-1799): what
// /api/v2/projects/{uuid}/alerting/contact-points accepts and returns. The
// backend, frontend and CLI share these.
import { type ContactPointIntegrationAsCode } from './asCode';

/**
 * One way of sending a notification. Secrets (Slack webhook URLs,
 * incident.io tokens, webhook authorization) are only ever
 * `{ secretRef: <name> }` references, the same as in as-code documents.
 */
export type ContactPointIntegration = ContactPointIntegrationAsCode;

export type ContactPointIntegrationType = ContactPointIntegration['type'];

export type ContactPoint = {
    uuid: string;
    projectUuid: string;
    /** Stable identifier; Notification Routes refer to Contact Points by it. */
    slug: string;
    name: string;
    integrations: ContactPointIntegration[];
    /** Uploaded as code; changed only through git. */
    managed: boolean;
    createdAt: string;
    updatedAt: string;
    createdByUserUuid: string | null;
    updatedByUserUuid: string | null;
};

export type CreateContactPoint = {
    name: string;
    /** Defaults to a slug of the name, made unique in the project. */
    slug?: string;
    integrations: ContactPointIntegration[];
};

/** The slug never changes, so Notification Routes keep pointing at it. */
export type UpdateContactPoint = Partial<
    Pick<ContactPoint, 'name' | 'integrations'>
>;
