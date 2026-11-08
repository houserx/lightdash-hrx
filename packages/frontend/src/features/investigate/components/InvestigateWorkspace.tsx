import {
    isAuditedSql,
    type QueryAudit,
    type QueryTimeRange,
    type TimeRangeInput,
} from '@lightdash/common';
import {
    Alert,
    Button,
    Group,
    Loader,
    Stack,
    Text,
    TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconPlayerPlay } from '@tabler/icons-react';
import { useRef, useState, type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import { TimeRangePicker } from '../../timeRange/components/TimeRangePicker';
import { getTimeRangeLabel } from '../../timeRange/utils';
import { type InvestigateRow } from '../utils/timeSeries';
import {
    InvestigateEditor,
    type InvestigateEditorChange,
} from './InvestigateEditor';
import { InvestigateResults } from './InvestigateResults';

/** Investigate opens over the last 6 hours unless the caller says otherwise. */
const DEFAULT_INVESTIGATE_TIME_RANGE: TimeRangeInput = {
    from: 'now-6h',
    to: 'now',
};

/** One Investigate run: the SQL as shown, and the range that resolves its time parameters. */
export type InvestigateRunRequest = {
    sql: string;
    timeRange: QueryTimeRange;
    /** Present only for an Audited Query (SQL touching the Platform Database). */
    audit?: QueryAudit;
};

export type InvestigateQueryResult = {
    columns: string[];
    rows: InvestigateRow[];
};

export type InvestigateWorkspaceProps = {
    runQuery: (
        request: InvestigateRunRequest,
    ) => Promise<InvestigateQueryResult>;
    /** The range the time range control starts from. */
    initialTimeRange?: TimeRangeInput;
};

type RunState =
    | { status: 'idle' }
    | { status: 'running'; timeRange: TimeRangeInput }
    | {
          status: 'done';
          timeRange: TimeRangeInput;
          result: InvestigateQueryResult;
      }
    | { status: 'failed'; timeRange: TimeRangeInput; error: string };

/**
 * Investigate: the query editor, one time range control and the result. Every run sends the
 * SQL in the SQL box with the range shown in the control; the result is labelled with the range
 * it was run over, so a later change to the control does not misdescribe it. SQL that touches
 * the Platform Database is an Audited Query: Run waits for a Description, a Linear ticket is
 * optional, and both are sent with the run.
 */
export const InvestigateWorkspace: FC<InvestigateWorkspaceProps> = ({
    runQuery,
    initialTimeRange = DEFAULT_INVESTIGATE_TIME_RANGE,
}) => {
    const [timeRange, setTimeRange] =
        useState<TimeRangeInput>(initialTimeRange);
    const [sql, setSql] = useState('');
    const [auditDescription, setAuditDescription] = useState('');
    const [auditTicket, setAuditTicket] = useState('');
    const [run, setRun] = useState<RunState>({ status: 'idle' });
    // Only the latest run may set the result; an earlier one finishing late is dropped.
    const latestRun = useRef(0);

    const handleEditorChange = (change: InvestigateEditorChange) =>
        setSql(change.sql);

    // Platform Database SQL is an Audited Query: the engine refuses it without a description.
    const isAudited = isAuditedSql(sql);
    const description = auditDescription.trim();
    const ticket = auditTicket.trim();
    const audit: QueryAudit | undefined = isAudited
        ? { description, ...(ticket && { ticket }) }
        : undefined;

    const handleRun = async () => {
        latestRun.current += 1;
        const runId = latestRun.current;
        const runTimeRange = { from: timeRange.from, to: timeRange.to };
        setRun({ status: 'running', timeRange: runTimeRange });
        try {
            const result = await runQuery({
                sql,
                timeRange: runTimeRange,
                ...(audit && { audit }),
            });
            if (runId !== latestRun.current) return;
            setRun({ status: 'done', timeRange: runTimeRange, result });
        } catch (error) {
            if (runId !== latestRun.current) return;
            setRun({
                status: 'failed',
                timeRange: runTimeRange,
                error:
                    error instanceof Error && error.message
                        ? error.message
                        : 'The query failed',
            });
        }
    };

    return (
        <Stack gap="md">
            <Group justify="space-between">
                <TimeRangePicker value={timeRange} onChange={setTimeRange} />
                <Button
                    size="xs"
                    leftSection={<MantineIcon icon={IconPlayerPlay} />}
                    disabled={
                        sql.trim() === '' ||
                        (isAudited && description === '') ||
                        run.status === 'running'
                    }
                    onClick={handleRun}
                >
                    Run
                </Button>
            </Group>
            <InvestigateEditor onChange={handleEditorChange} />
            {isAudited && (
                <Group align="flex-start" grow>
                    <TextInput
                        label="Description"
                        description="Why you are running this Audited Query; it is recorded in the audit log."
                        required
                        value={auditDescription}
                        onChange={(event) =>
                            setAuditDescription(event.currentTarget.value)
                        }
                    />
                    <TextInput
                        label="Linear ticket"
                        description="Optional, e.g. ENG-123."
                        placeholder="ENG-123"
                        value={auditTicket}
                        onChange={(event) =>
                            setAuditTicket(event.currentTarget.value)
                        }
                    />
                </Group>
            )}
            {run.status !== 'idle' && (
                <Stack gap="xs" data-testid="investigate-result">
                    <Text size="xs" c="dimmed">
                        Results over {getTimeRangeLabel(run.timeRange)}
                    </Text>
                    {run.status === 'running' && <Loader size="sm" />}
                    {run.status === 'failed' && (
                        <Alert
                            color="red"
                            icon={<MantineIcon icon={IconAlertCircle} />}
                            title="Query failed"
                        >
                            {run.error}
                        </Alert>
                    )}
                    {run.status === 'done' && (
                        <InvestigateResults
                            columns={run.result.columns}
                            rows={run.result.rows}
                        />
                    )}
                </Stack>
            )}
        </Stack>
    );
};
