import {
    buildPlatformQuerySql,
    buildTelemetrySql,
    type TelemetryQuery,
} from '@lightdash/common';
import {
    Checkbox,
    SegmentedControl,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '@mantine/core';
import { useEffect, useMemo, useRef, useState, type FC } from 'react';

/** The source languages Investigate offers (CONTRACTS §1.1). */
export type InvestigateSource =
    | 'prometheus'
    | 'loki'
    | 'cloudwatch'
    | 'cloudwatch_logs'
    | 'tempo'
    | 'platform';

const SOURCE_OPTIONS: { value: InvestigateSource; label: string }[] = [
    { value: 'prometheus', label: 'Prometheus' },
    { value: 'loki', label: 'Loki' },
    { value: 'cloudwatch', label: 'CloudWatch metrics' },
    { value: 'cloudwatch_logs', label: 'CloudWatch Logs' },
    { value: 'tempo', label: 'Tempo' },
    { value: 'platform', label: 'Platform Database' },
];

/** What the editor reports: the query kind and the SQL that runs. */
export type InvestigateEditorChange =
    | { kind: TelemetryQuery['kind']; sql: string }
    | { kind: 'platform'; sql: string; statement: string };

type Props = {
    onChange: (change: InvestigateEditorChange) => void;
};

/**
 * Investigate's query editor: a source picker, the editor for the picked source's language,
 * and the SQL box with the table-function SQL generated from it (CONTRACTS §1.1). Telemetry
 * SQL uses the reserved time parameters, so it follows the chosen time range.
 */
export const InvestigateEditor: FC<Props> = ({ onChange }) => {
    const [source, setSource] = useState<InvestigateSource>('prometheus');
    const [promql, setPromql] = useState('');
    const [logql, setLogql] = useState('');
    const [isLogqlMetric, setIsLogqlMetric] = useState(false);
    const [traceql, setTraceql] = useState('');
    const [platformSql, setPlatformSql] = useState('');
    const [sourceName, setSourceName] = useState('');

    const change = useMemo((): InvestigateEditorChange | undefined => {
        const engineSource = sourceName.trim() || undefined;
        const telemetry = (query: TelemetryQuery): InvestigateEditorChange => ({
            kind: query.kind,
            sql: buildTelemetrySql(query),
        });
        switch (source) {
            case 'prometheus':
                return promql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: 'promql',
                          query: promql,
                          source: engineSource,
                      });
            case 'loki':
                return logql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: isLogqlMetric ? 'logql_metric' : 'logql',
                          query: logql,
                          source: engineSource,
                      });
            case 'tempo':
                return traceql.trim() === ''
                    ? undefined
                    : telemetry({
                          kind: 'traceql',
                          query: traceql,
                          source: engineSource,
                      });
            case 'platform':
                return platformSql.trim() === ''
                    ? undefined
                    : {
                          kind: 'platform',
                          statement: platformSql,
                          sql: buildPlatformQuerySql(platformSql),
                      };
            case 'cloudwatch':
            case 'cloudwatch_logs':
                return undefined;
            default: {
                const unknownSource: never = source;
                throw new Error(`Unknown Investigate source: ${unknownSource}`);
            }
        }
    }, [
        source,
        promql,
        logql,
        isLogqlMetric,
        traceql,
        platformSql,
        sourceName,
    ]);

    // Report each new SQL once; the parent's callback identity does not matter.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
        if (change) onChangeRef.current(change);
    }, [change]);

    return (
        <Stack gap="sm">
            <SegmentedControl
                aria-label="Source"
                data={SOURCE_OPTIONS}
                value={source}
                onChange={(value) => setSource(value as InvestigateSource)}
            />
            {source === 'prometheus' && (
                <Textarea
                    label="PromQL"
                    autosize
                    minRows={2}
                    value={promql}
                    onChange={(event) => setPromql(event.currentTarget.value)}
                />
            )}
            {source === 'loki' && (
                <>
                    <Textarea
                        label="LogQL"
                        autosize
                        minRows={2}
                        value={logql}
                        onChange={(event) =>
                            setLogql(event.currentTarget.value)
                        }
                    />
                    <Checkbox
                        label="Metric query"
                        checked={isLogqlMetric}
                        onChange={(event) =>
                            setIsLogqlMetric(event.currentTarget.checked)
                        }
                    />
                </>
            )}
            {source === 'tempo' && (
                <Textarea
                    label="TraceQL"
                    autosize
                    minRows={2}
                    value={traceql}
                    onChange={(event) => setTraceql(event.currentTarget.value)}
                />
            )}
            {source === 'platform' && (
                <Textarea
                    label="Platform SQL"
                    autosize
                    minRows={4}
                    value={platformSql}
                    onChange={(event) =>
                        setPlatformSql(event.currentTarget.value)
                    }
                />
            )}
            {(source === 'cloudwatch' || source === 'cloudwatch_logs') && (
                <Text size="sm" c="dimmed">
                    The CloudWatch editor is not available yet.
                </Text>
            )}
            {source !== 'platform' && (
                <TextInput
                    label="Source name"
                    description="Optional. Leave empty to use the default source."
                    value={sourceName}
                    onChange={(event) =>
                        setSourceName(event.currentTarget.value)
                    }
                />
            )}
            <Textarea
                label="SQL"
                autosize
                minRows={3}
                readOnly
                value={change?.sql ?? ''}
            />
        </Stack>
    );
};
