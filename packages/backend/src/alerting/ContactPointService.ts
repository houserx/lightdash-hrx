import {
    ALERTING_AS_CODE_VERSION,
    AlreadyExistsError,
    ConflictError,
    ForbiddenError,
    generateSlug,
    getNotificationRouteContactPoints,
    NotFoundError,
    ParameterError,
    validateAlertingAsCode,
    type ContactPoint,
    type ContactPointAsCode,
    type CreateContactPoint,
    type SessionUser,
    type UpdateContactPoint,
} from '@lightdash/common';
import {
    assertAlertingAbility,
    isUniqueViolation,
    nextFreeSlug,
    SLUG_PATTERN,
    UUID_PATTERN,
    type AlertingAction,
} from './alertingAccess';
import {
    type AlertNotifier,
    type ContactPointTestResult,
} from './AlertNotifier';
import { type ContactPointModel } from './ContactPointModel';
import { type NotificationRouteModel } from './NotificationRouteModel';

const CREATE_KEYS = ['name', 'slug', 'integrations'] as const;
const UPDATE_KEYS = ['name', 'integrations'] as const;
const MAX_SLUG_ATTEMPTS = 5;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Object body with only `allowed` keys, else a 400. */
const parseBody = (
    body: unknown,
    allowed: readonly string[],
): Record<string, unknown> => {
    if (!isPlainObject(body)) {
        throw new ParameterError('The Contact Point must be a JSON object');
    }
    const unknownKeys = Object.keys(body).filter(
        (key) => !allowed.includes(key),
    );
    if (unknownKeys.length > 0) {
        throw new ParameterError(
            `Unknown Contact Point field: ${unknownKeys.join(', ')}`,
        );
    }
    if ('name' in body && typeof body.name !== 'string') {
        throw new ParameterError('name must be a string');
    }
    return body;
};

/**
 * Checks a whole Contact Point against the same JSON schema as its as-code
 * document, so the API and uploads accept exactly the same integrations.
 * An inline secret is a 400 that names `secretRef`.
 */
const validateContactPoint = (contactPoint: {
    slug: string;
    name: unknown;
    integrations: unknown;
}): Pick<ContactPoint, 'name' | 'integrations'> => {
    const document = {
        version: ALERTING_AS_CODE_VERSION,
        type: 'contact_point',
        slug: contactPoint.slug,
        name: contactPoint.name,
        integrations: contactPoint.integrations,
    };
    const { valid, errors } = validateAlertingAsCode(document);
    if (!valid) {
        throw new ParameterError(
            `Invalid Contact Point: ${errors.join('; ')}`,
            {
                errors,
            },
        );
    }
    const { name, integrations } = document as ContactPointAsCode;
    return { name, integrations };
};

export class ContactPointService {
    constructor(
        private readonly deps: {
            contactPointModel: ContactPointModel;
            notificationRouteModel: NotificationRouteModel;
            testNotifier: Pick<AlertNotifier, 'sendTest'>;
            clock: { now(): Date };
        },
    ) {}

    private async assertAbility(
        user: SessionUser,
        action: AlertingAction,
        projectUuid: string,
    ) {
        await assertAlertingAbility(
            this.deps.contactPointModel,
            user,
            action,
            'ContactPoint',
            projectUuid,
        );
    }

    private async getOrThrow(
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<ContactPoint> {
        const contactPoint = UUID_PATTERN.test(contactPointUuid)
            ? await this.deps.contactPointModel.find(
                  projectUuid,
                  contactPointUuid,
              )
            : undefined;
        if (!contactPoint) {
            throw new NotFoundError('Contact Point not found');
        }
        return contactPoint;
    }

    async list(
        user: SessionUser,
        projectUuid: string,
    ): Promise<ContactPoint[]> {
        await this.assertAbility(user, 'view', projectUuid);
        return this.deps.contactPointModel.list(projectUuid);
    }

    async get(
        user: SessionUser,
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<ContactPoint> {
        await this.assertAbility(user, 'view', projectUuid);
        return this.getOrThrow(projectUuid, contactPointUuid);
    }

    async create(
        user: SessionUser,
        projectUuid: string,
        body: unknown,
    ): Promise<ContactPoint> {
        await this.assertAbility(user, 'manage', projectUuid);
        const input = parseBody(body, CREATE_KEYS);
        if (typeof input.name !== 'string' || input.name.trim() === '') {
            throw new ParameterError('name is required and must not be blank');
        }
        if (
            'slug' in input &&
            (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug))
        ) {
            throw new ParameterError(
                'slug must be lowercase letters, digits and single hyphens',
            );
        }
        const requestedSlug = input.slug as CreateContactPoint['slug'];
        // The slug is generated after validation; any valid one will do here.
        const { name, integrations } = validateContactPoint({
            slug: requestedSlug ?? 'contact-point',
            name: input.name,
            integrations: input.integrations,
        });
        const contactPointUuid = await this.insert({
            user,
            projectUuid,
            name,
            integrations,
            requestedSlug,
            attempt: 1,
        });
        return this.getOrThrow(projectUuid, contactPointUuid);
    }

    private async insert(args: {
        user: SessionUser;
        projectUuid: string;
        name: string;
        integrations: ContactPoint['integrations'];
        requestedSlug: string | undefined;
        attempt: number;
    }): Promise<string> {
        let slug = args.requestedSlug;
        if (slug === undefined) {
            const base = generateSlug(args.name);
            slug = nextFreeSlug(
                base,
                await this.deps.contactPointModel.getSlugs(
                    args.projectUuid,
                    base,
                ),
            );
        }
        try {
            return await this.deps.contactPointModel.create({
                projectUuid: args.projectUuid,
                slug,
                name: args.name,
                integrations: args.integrations,
                userUuid: args.user.userUuid,
                now: this.deps.clock.now(),
            });
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            if (args.requestedSlug !== undefined) {
                throw new AlreadyExistsError(
                    `A Contact Point with slug "${slug}" already exists in this project`,
                );
            }
            // A concurrent create took the generated slug: pick again.
            if (args.attempt >= MAX_SLUG_ATTEMPTS) throw error;
            return this.insert({ ...args, attempt: args.attempt + 1 });
        }
    }

    async update(
        user: SessionUser,
        projectUuid: string,
        contactPointUuid: string,
        body: unknown,
    ): Promise<ContactPoint> {
        await this.assertAbility(user, 'manage', projectUuid);
        const change = parseBody(body, UPDATE_KEYS) as UpdateContactPoint;
        await this.getOrThrow(projectUuid, contactPointUuid);
        const updated = await this.deps.contactPointModel.update({
            projectUuid,
            contactPointUuid,
            userUuid: user.userUuid,
            now: this.deps.clock.now(),
            apply: (current) => {
                if (current.managed) {
                    throw new ForbiddenError(
                        'This Contact Point is managed in git; change it there and upload it again',
                    );
                }
                return validateContactPoint({ ...current, ...change });
            },
        });
        if (!updated) throw new NotFoundError('Contact Point not found');
        return this.getOrThrow(projectUuid, contactPointUuid);
    }

    /**
     * 'Send test notification': a synthetic TestAlert through every
     * integration, reporting each outcome. A failed send is a result, not an
     * error, so the request itself succeeds.
     */
    async sendTest(
        user: SessionUser,
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<ContactPointTestResult> {
        await this.assertAbility(user, 'manage', projectUuid);
        const contactPoint = await this.getOrThrow(
            projectUuid,
            contactPointUuid,
        );
        return this.deps.testNotifier.sendTest(projectUuid, contactPoint);
    }

    async delete(
        user: SessionUser,
        projectUuid: string,
        contactPointUuid: string,
    ): Promise<void> {
        await this.assertAbility(user, 'manage', projectUuid);
        const contactPoint = await this.getOrThrow(
            projectUuid,
            contactPointUuid,
        );
        if (contactPoint.managed) {
            throw new ForbiddenError(
                'This Contact Point is managed in git; remove it there instead',
            );
        }
        const deleted = await this.deps.contactPointModel.delete({
            projectUuid,
            contactPointUuid,
            // Read under the deleted row's lock: a tree save that names this
            // Contact Point either committed already or waits and fails.
            beforeCommit: async (trx, removed) => {
                const tree = await this.deps.notificationRouteModel.find(
                    projectUuid,
                    trx,
                );
                if (
                    tree &&
                    getNotificationRouteContactPoints(tree).includes(
                        removed.slug,
                    )
                ) {
                    throw new ConflictError(
                        `Contact Point "${removed.slug}" is used by the Notification Route tree; change the tree first`,
                        { slug: removed.slug },
                    );
                }
            },
        });
        if (!deleted) throw new NotFoundError('Contact Point not found');
    }
}
