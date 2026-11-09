// Shared types and the error of the message template engine (ENG-1799).

export class AlertTemplateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AlertTemplateError';
    }
}

/** One alert as Grafana's notification templates see it. */
export type AlertTemplateAlert = {
    Status: 'firing' | 'resolved';
    Labels: Record<string, string>;
    Annotations: Record<string, string>;
    StartsAt: string;
    EndsAt: string;
    Fingerprint: string;
    GeneratorURL: string;
    SilenceURL: string;
    DashboardURL: string;
    ValueString: string;
};

/** The data (`.`) of a notification template, the same shape as Grafana's. */
export type AlertTemplateData = {
    Receiver: string;
    Status: 'firing' | 'resolved';
    Alerts: AlertTemplateAlert[];
    GroupLabels: Record<string, string>;
    CommonLabels: Record<string, string>;
    CommonAnnotations: Record<string, string>;
    ExternalURL: string;
};

export type AlertTemplateOptions = {
    /** Extra template source(s) whose `define`s the template can call. */
    templates?: string | string[];
    /**
     * Variables defined at the top of the template besides `$`, named
     * without the `$`: `{ labels: {...} }` defines `$labels`.
     */
    variables?: Record<string, unknown>;
};
