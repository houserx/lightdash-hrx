import { describe, expect, it } from 'vitest';
import { renderAlertTemplate as render } from './templateEngine';
import { AlertTemplateError } from './templateTypes';

const alert = (status: 'firing' | 'resolved', instance: string) => ({
    Status: status,
    Labels: { alertname: 'Disk almost full', instance },
    Annotations: { summary: 'Disk almost full' },
    SilenceURL: '',
});

const data = {
    Status: 'firing',
    Alerts: [
        alert('firing', 'db-1'),
        alert('resolved', 'db-2'),
        alert('firing', 'db-3'),
    ],
    CommonLabels: { alertname: 'Disk almost full' },
};

describe('renderAlertTemplate', () => {
    it('renders text, fields, map keys and missing keys', () => {
        expect(render('plain text', data)).toBe('plain text');
        expect(render('{{ .Status }}', data)).toBe('firing');
        expect(render('{{ .CommonLabels.alertname }}', data)).toBe(
            'Disk almost full',
        );
        expect(render('[{{ .CommonLabels.nope }}]', data)).toBe('[]');
        expect(render('[{{ .Nope.deeper }}]', data)).toBe('[]');
        expect(render('{{ . }}', 'dot')).toBe('dot');
    });

    it('derives .Alerts.Firing and .Alerts.Resolved from Status', () => {
        expect(
            render(
                '{{ range .Alerts.Firing }}{{ .Labels.instance }};{{ end }}',
                data,
            ),
        ).toBe('db-1;db-3;');
        expect(
            render(
                '{{ range .Alerts.Resolved }}{{ .Labels.instance }}{{ end }}',
                data,
            ),
        ).toBe('db-2');
        expect(render('{{ len .Alerts.Firing }}', data)).toBe('2');
    });

    it('supports if / else if / else and with', () => {
        const t =
            '{{ if eq .Status "a" }}A{{ else if eq .Status "firing" }}F{{ else }}?{{ end }}';
        expect(render(t, data)).toBe('F');
        expect(render(t, { Status: 'x' })).toBe('?');
        expect(render('{{ if .Alerts }}y{{ end }}', { Alerts: [] })).toBe('');
        expect(
            render('{{ with .CommonLabels }}{{ .alertname }}{{ end }}', data),
        ).toBe('Disk almost full');
        expect(render('{{ with .Nope }}x{{ else }}none{{ end }}', data)).toBe(
            'none',
        );
    });

    it('ranges over lists, maps and nothing, with variables, break and continue', () => {
        expect(
            render('{{ range $i, $a := .Alerts }}{{ $i }}{{ end }}', data),
        ).toBe('012');
        expect(
            render('{{ range $k, $v := . }}{{ $k }}={{ $v }},{{ end }}', {
                b: '2',
                a: '1',
            }),
        ).toBe('a=1,b=2,');
        expect(render('{{ range .Nope }}x{{ else }}empty{{ end }}', data)).toBe(
            'empty',
        );
        expect(
            render(
                '{{ range .Alerts }}{{ if eq .Status "resolved" }}{{ break }}{{ end }}{{ .Labels.instance }}{{ end }}',
                data,
            ),
        ).toBe('db-1');
        expect(
            render(
                '{{ range .Alerts }}{{ if eq .Status "resolved" }}{{ continue }}{{ end }}{{ .Labels.instance }}{{ end }}',
                data,
            ),
        ).toBe('db-1db-3');
        expect(
            render(
                '{{ $n := 0 }}{{ range .Alerts }}{{ $n = .Labels.instance }}{{ end }}{{ $n }} {{ $.Status }}',
                data,
            ),
        ).toBe('db-3 firing');
    });

    it('evaluates pipelines, parentheses and literals', () => {
        expect(render('{{ .Status | len }}', data)).toBe('6');
        expect(render('{{ (index .Alerts 2).Labels.instance }}', data)).toBe(
            'db-3',
        );
        expect(render('{{ index .CommonLabels "alertname" }}', data)).toBe(
            'Disk almost full',
        );
        expect(render('{{ 1.5 }} {{ -3 }} {{ 0x10 }} {{ true }}', data)).toBe(
            '1.5 -3 16 true',
        );
        expect(render('{{ `raw "x"` }} {{ "a\\tb" }}', data)).toBe(
            'raw "x" a\tb',
        );
    });

    it('implements the comparison and logic functions like Go', () => {
        expect(
            render('{{ gt 2 1 }} {{ lt 2 1 }} {{ ge 1 1 }} {{ le 1 2 }}', data),
        ).toBe('true false true true');
        expect(render('{{ eq .Status "x" "firing" }} {{ ne 1 2 }}', data)).toBe(
            'true true',
        );
        expect(render('{{ lt "a" "b" }}', data)).toBe('true');
        expect(render('{{ eq .CommonLabels.nope "" }}', data)).toBe('true');
        expect(
            render('{{ and 1 0 2 }} {{ or 0 "" "x" }} {{ not 0 }}', data),
        ).toBe('0 x true');
        expect(() => render('{{ gt 1 "a" }}', data)).toThrow(
            /incompatible types/,
        );
        expect(() => render('{{ eq .Alerts 1 }}', data)).toThrow(
            /non-comparable/,
        );
    });

    it('implements print, printf and the escapers', () => {
        expect(render('{{ print 1 2 "a" "b" }}', data)).toBe('1 2ab');
        expect(render('{{ println "a" 1 }}', data)).toBe('a 1\n');
        expect(
            render(
                '{{ printf "%s has %d alerts (%.1f%%) %v" .Status 3 12.345 true }}',
                data,
            ),
        ).toBe('firing has 3 alerts (12.3%) true');
        expect(render('{{ printf "%05d|%-4s|" 42 "ab" }}', data)).toBe(
            '00042|ab  |',
        );
        expect(render('{{ printf "%s" }}', data)).toBe('%!s(MISSING)');
        expect(render(`{{ html "<a href='x'>&</a>" }}`, data)).toBe(
            '&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;',
        );
        expect(render(`{{ js "it's <b>" }}`, data)).toBe(
            "it\\'s \\u003Cb\\u003E",
        );
        expect(render('{{ urlquery "a b&c" }}', data)).toBe('a+b%26c');
        expect(
            render('{{ toUpper "ab" }} {{ title "disk almost-full" }}', data),
        ).toBe('AB Disk Almost-Full');
        expect(
            render(
                '{{ join ", " (stringSlice "a" "b") }} {{ slice "abcd" 1 3 }}',
                data,
            ),
        ).toBe('a, b bc');
    });

    it('trims whitespace around {{- and -}} and skips comments', () => {
        expect(render('a  {{- " b " -}}  c', data)).toBe('a b c');
        expect(render('x \n {{- /* note */ -}} \n y', data)).toBe('xy');
        expect(render('x{{/* note */}}y', data)).toBe('xy');
        expect(render('{{ -1 }}', data)).toBe('-1');
    });

    it('defines and calls templates, from the template or the templates option', () => {
        const templates = [
            '{{ define "inst" }}[{{ .Labels.instance }}]{{ end }}',
            '{{ define "list" }}{{ range . }}{{ template "inst" . }}{{ end }}{{ end }}',
        ];
        expect(
            render('{{ template "list" .Alerts.Firing }}', data, { templates }),
        ).toBe('[db-1][db-3]');
        expect(
            render(
                '{{ define "inst" }}<{{ .Labels.instance }}>{{ end }}{{ template "list" .Alerts }}',
                data,
                { templates },
            ),
        ).toBe('<db-1><db-2><db-3>');
        expect(
            render('{{ define "x" }}X{{ end }}{{ template "x" }}', data),
        ).toBe('X');
        expect(render('{{ block "b" .Status }}<{{ . }}>{{ end }}', data)).toBe(
            '<firing>',
        );
    });

    it('renders the infra Slack MS template constructs', () => {
        const templates = `{{ define "fired" }}
  {{ range . }}   - {{ index .Labels "instance" }} {{ if gt (len .SilenceURL) 0 }}(<{{ .SilenceURL }} | Silence>){{ end }}
  {{ end }}
{{ end }}
{{ define "msg" }}
  {{ if gt (len .Alerts.Firing) 0 }}
    {{ template "fired" .Alerts.Firing }}{{ if gt (len .Alerts.Resolved) 0 }}
{{- end }}{{- end }}
{{ end }}`;
        const text = render('{{ template "msg" . }}', data, { templates })
            .replace(/\s+/g, ' ')
            .trim();
        expect(text).toBe('- db-1 - db-3');
    });

    it('throws an AlertTemplateError naming unknown templates', () => {
        expect(() => render('{{ template "nope" . }}', data)).toThrow(
            AlertTemplateError,
        );
        expect(() => render('{{ template "nope" . }}', data)).toThrow(
            'no such template "nope"',
        );
    });

    it('throws on parse errors with the template name and line', () => {
        expect(() => render('{{ if }}', data)).toThrow(
            'template: message:1: missing value for if',
        );
        expect(() => render('\n{{ if .X }}', data)).toThrow(
            'template: message:2: unexpected EOF',
        );
        expect(() => render('{{ end }}', data)).toThrow('unexpected {{end}}');
        expect(() => render('{{ nope 1 }}', data)).toThrow(
            'function "nope" not defined',
        );
        expect(() => render('{{ .X 1 }}', data)).toThrow(
            "can't give argument to non-function",
        );
        expect(() => render('{{ "x" ', data)).toThrow('unclosed action');
        expect(() => render('{{ break }}', data)).toThrow('outside {{range}}');
        expect(() => render('{{ $x }}', data)).toThrow(
            'undefined variable "$x"',
        );
        expect(() =>
            render('', data, { templates: '{{ define "a" }}' }),
        ).toThrow('template: templates:1: unexpected EOF');
    });

    it('stops runaway recursion and refuses prototype fields', () => {
        expect(() =>
            render(
                '{{ define "r" }}{{ template "r" . }}{{ end }}{{ template "r" . }}',
                data,
            ),
        ).toThrow(/maximum template depth/);
        expect(
            render('[{{ .constructor }}{{ .Status.length }}]', { Status: {} }),
        ).toBe('[]');
        expect(() => render('{{ .Status.length }}', data)).toThrow(
            "can't evaluate field length in type string",
        );
    });
});
