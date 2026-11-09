// Annotation templates (ENG-1799). A rule's annotations are templates
// rendered per series, as in Grafana and Prometheus:
// - `{{ $labels.instance }}` / `{{ .Labels.instance }}` is the series' label;
// - `{{ $value }}` / `{{ .Value }}` is the series' reduced value (a number, so
//   `{{ if gt $value 98.0 }}` works), empty when the series has none.
// An annotation whose template fails to parse or run keeps its original
// text, as Grafana does, so a typo never drops an alert.
import { renderAlertTemplate } from './templateEngine';

/** What an annotation template sees of one series. */
export type AlertAnnotationTemplateData = {
    labels: Record<string, string>;
    value: number | null;
};

/** Renders one annotation template for a series. */
export const renderAlertAnnotation = (
    template: string,
    { labels, value }: AlertAnnotationTemplateData,
): string => {
    if (!template.includes('{{')) return template;
    try {
        return renderAlertTemplate(
            template,
            { Labels: labels, Value: value },
            { variables: { labels, value } },
        );
    } catch {
        return template;
    }
};

/** Renders every annotation of a rule for a series. */
export const renderAlertAnnotations = (
    annotations: Record<string, string>,
    data: AlertAnnotationTemplateData,
): Record<string, string> =>
    Object.fromEntries(
        Object.entries(annotations).map(([key, template]) => [
            key,
            renderAlertAnnotation(template, data),
        ]),
    );
