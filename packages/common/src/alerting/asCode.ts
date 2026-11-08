// Alerting as code (ENG-1799): the alert_rule, contact_point and
// notification_routes document types, validated against the JSON schemas in
// src/schemas/json. Secrets are never inline: every secret field is a
// `{ secretRef: <name> }` object.
import { type ErrorObject, type ValidateFunction } from 'ajv';
import AjvErrors from 'ajv-errors';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020';
import alertRuleAsCodeSchema from '../schemas/json/alert-rule-as-code-1.0.json';
import contactPointAsCodeSchema from '../schemas/json/contact-point-as-code-1.0.json';
import notificationRoutesAsCodeSchema from '../schemas/json/notification-routes-as-code-1.0.json';
import { type AlertCondition } from './conditions';
import { type AlertReducer } from './reducers';
import {
    getAlertLabelMatcherError,
    type AlertLabelMatcher,
} from './routingMatchers';
import { type NotificationRoute } from './routingTree';

export const ALERTING_AS_CODE_VERSION = 1;

export const ALERTING_AS_CODE_TYPES = [
    'alert_rule',
    'contact_point',
    'notification_routes',
] as const;

export type AlertingAsCodeType = (typeof ALERTING_AS_CODE_TYPES)[number];

export const ALERT_NO_DATA_STATES = [
    'nodata',
    'normal',
    'alerting',
    'keep_last',
] as const;

export type AlertNoDataState = (typeof ALERT_NO_DATA_STATES)[number];

export const ALERT_ERROR_STATES = ['error', 'alerting', 'keep_last'] as const;

export type AlertErrorState = (typeof ALERT_ERROR_STATES)[number];

export type AlertingSecretRef = { secretRef: string };

export type AlertRuleAsCode = {
    version: 1;
    type: 'alert_rule';
    slug: string;
    name: string;
    description: string;
    spaceSlug: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    query: string;
    valueColumn?: string;
    reducer?: AlertReducer;
    condition: AlertCondition;
    for?: string;
    keepFiringFor?: string;
    interval?: string;
    timeRange?: string;
    noDataState?: AlertNoDataState;
    errorState?: AlertErrorState;
    paused?: boolean;
    shadow?: boolean;
};

export type ContactPointIntegrationAsCode =
    | {
          type: 'slack_webhook';
          url: AlertingSecretRef;
          title?: string;
          text?: string;
          disableResolveMessage?: boolean;
      }
    | {
          type: 'slack_app';
          channel: string;
          title?: string;
          text?: string;
          disableResolveMessage?: boolean;
      }
    | {
          type: 'incident_io';
          url: string;
          token: AlertingSecretRef;
          disableResolveMessage?: boolean;
      }
    | {
          type: 'email';
          addresses: string[];
          disableResolveMessage?: boolean;
      }
    | {
          type: 'webhook';
          url: string;
          authorization?: AlertingSecretRef;
          maxAlerts?: number;
          disableResolveMessage?: boolean;
      };

export type ContactPointAsCode = {
    version: 1;
    type: 'contact_point';
    slug: string;
    name: string;
    integrations: ContactPointIntegrationAsCode[];
};

export type NotificationRoutesAsCode = Omit<
    NotificationRoute,
    'id' | 'matchers' | 'continue' | 'contactPoint'
> & {
    version: 1;
    type: 'notification_routes';
    contactPoint: string;
};

export type AlertingAsCodeDocument =
    | AlertRuleAsCode
    | ContactPointAsCode
    | NotificationRoutesAsCode;

export type AlertingAsCodeValidationResult = {
    valid: boolean;
    errors: string[];
};

const SCHEMAS: Record<AlertingAsCodeType, object> = {
    alert_rule: alertRuleAsCodeSchema,
    contact_point: contactPointAsCodeSchema,
    notification_routes: notificationRoutesAsCodeSchema,
};

// Compiled on first use, so importing the package never runs Ajv's code
// generation (which needs `new Function`, see dbt/validation.ts).
let validators: Record<AlertingAsCodeType, ValidateFunction> | undefined;

const getValidators = (): Record<AlertingAsCodeType, ValidateFunction> => {
    if (!validators) {
        const ajv = new Ajv2020({ allErrors: true, strict: false });
        addFormats(ajv);
        AjvErrors(ajv);
        validators = {
            alert_rule: ajv.compile(SCHEMAS.alert_rule),
            contact_point: ajv.compile(SCHEMAS.contact_point),
            notification_routes: ajv.compile(SCHEMAS.notification_routes),
        };
    }
    return validators;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isAlertingAsCodeType = (value: unknown): value is AlertingAsCodeType =>
    ALERTING_AS_CODE_TYPES.includes(value as AlertingAsCodeType);

// `/integrations/0/url` -> `integrations[0].url`
const formatPath = (segments: string[]): string =>
    segments
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((out, s) => {
            if (/^\d+$/.test(s)) return `${out}[${s}]`;
            return out ? `${out}.${s}` : s;
        }, '') || 'document';

const formatAjvError = (error: ErrorObject): string => {
    const segments = error.instancePath.split('/').filter(Boolean);
    switch (error.keyword) {
        case 'required':
            return `${formatPath([...segments, error.params.missingProperty])}: is required`;
        case 'additionalProperties':
            return `${formatPath([...segments, error.params.additionalProperty])}: is not allowed`;
        case 'enum':
            return `${formatPath(segments)}: must be one of ${(
                error.params.allowedValues as unknown[]
            )
                .map(String)
                .join(', ')}`;
        case 'const':
            return `${formatPath(segments)}: must be ${JSON.stringify(
                error.params.allowedValue,
            )}`;
        case 'pattern':
            // The schemas' non-blank strings use the pattern \S.
            return error.params.pattern === '\\S'
                ? `${formatPath(segments)}: must not be empty`
                : `${formatPath(segments)}: ${error.message}`;
        default:
            return `${formatPath(segments)}: ${error.message}`;
    }
};

// Checks JSON schema can't express: valid matcher regexes and range order.
const semanticErrors = (
    type: AlertingAsCodeType,
    document: Record<string, unknown>,
): string[] => {
    if (type === 'alert_rule') {
        const condition = document.condition as Record<string, number>;
        return 'min' in condition && condition.min > condition.max
            ? ['condition: min must not be greater than max']
            : [];
    }
    if (type === 'notification_routes') {
        const walk = (route: NotificationRoute, path: string): string[] => [
            ...(route.matchers ?? []).flatMap(
                (matcher: AlertLabelMatcher, i: number) => {
                    const error = getAlertLabelMatcherError(matcher);
                    return error ? [`${path}matchers[${i}]: ${error}`] : [];
                },
            ),
            ...(route.routes ?? []).flatMap((child, i) =>
                walk(child, `${path}routes[${i}].`),
            ),
        ];
        return walk(document as NotificationRoute, '');
    }
    return [];
};

/**
 * Validates one alerting document (alert_rule, contact_point or
 * notification_routes, picked by its `type`) against its JSON schema.
 * Errors are readable, one per problem, prefixed with the field path; an
 * inline secret is reported as needing a `secretRef`.
 */
export const validateAlertingAsCode = (
    document: unknown,
): AlertingAsCodeValidationResult => {
    if (!isRecord(document)) {
        return { valid: false, errors: ['document: must be an object'] };
    }
    if (!isAlertingAsCodeType(document.type)) {
        return {
            valid: false,
            errors: [
                `type: must be one of ${ALERTING_AS_CODE_TYPES.join(', ')}`,
            ],
        };
    }
    const validate = getValidators()[document.type];
    if (!validate(document)) {
        const errors = (validate.errors ?? [])
            // An if/then failure only repeats the errors of its `then` branch.
            .filter((e) => e.keyword !== 'if')
            .map(formatAjvError);
        return { valid: false, errors: [...new Set(errors)] };
    }
    const errors = semanticErrors(document.type, document);
    return { valid: errors.length === 0, errors };
};

export const isAlertingAsCodeDocument = (
    document: unknown,
): document is AlertingAsCodeDocument => validateAlertingAsCode(document).valid;
