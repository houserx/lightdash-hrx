import {
    renderAlertAnnotation,
    renderAlertAnnotations,
} from './annotationTemplates';

const series = { labels: { instance: 'db-1', team: 'infra' }, value: 95 };

describe('renderAlertAnnotation', () => {
    it('renders $labels and $value', () => {
        expect(
            renderAlertAnnotation(
                'Disk on {{ $labels.instance }} is {{ $value }}%',
                series,
            ),
        ).toBe('Disk on db-1 is 95%');
    });

    it('renders .Labels and .Value', () => {
        expect(
            renderAlertAnnotation('{{ .Labels.team }}: {{ .Value }}', series),
        ).toBe('infra: 95');
    });

    it('compares $value as a number', () => {
        const template =
            '{{ if gt $value 98.0 }}critical{{ else }}warning{{ end }}';
        expect(renderAlertAnnotation(template, series)).toBe('warning');
        expect(renderAlertAnnotation(template, { ...series, value: 99 })).toBe(
            'critical',
        );
    });

    it('renders a missing label and no value as empty', () => {
        expect(
            renderAlertAnnotation('[{{ $labels.host }}][{{ $value }}]', {
                labels: {},
                value: null,
            }),
        ).toBe('[][]');
    });

    it('keeps the original text when the template fails', () => {
        expect(renderAlertAnnotation('{{ $labels.x', series)).toBe(
            '{{ $labels.x',
        );
        expect(renderAlertAnnotation('{{ template "nope" }}', series)).toBe(
            '{{ template "nope" }}',
        );
    });
});

describe('renderAlertAnnotations', () => {
    it('renders every annotation and keeps plain text', () => {
        expect(
            renderAlertAnnotations(
                {
                    summary: '{{ $labels.instance }} at {{ $value }}',
                    runbook_url: 'https://runbooks.example.test/disk',
                },
                series,
            ),
        ).toEqual({
            summary: 'db-1 at 95',
            runbook_url: 'https://runbooks.example.test/disk',
        });
    });
});
