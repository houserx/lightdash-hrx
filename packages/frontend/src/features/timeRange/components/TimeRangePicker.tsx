// Time range control shared by dashboards and Investigate: quick relative
// ranges, an absolute (or typed relative) From/To, and, when the caller
// supports it, the auto-refresh interval.
import {
    DASHBOARD_REFRESH_INTERVALS,
    isDashboardRefreshInterval,
    type DashboardRefreshInterval,
    type TimeRangeInput,
} from '@lightdash/common';
import {
    Box,
    Button,
    Divider,
    Group,
    NativeSelect,
    Popover,
    Stack,
    Text,
    TextInput,
} from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { useState, type FC, type FormEvent } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';
import {
    getTimeRangeInputError,
    getTimeRangeLabel,
    isSameTimeRange,
    QUICK_TIME_RANGES,
} from '../utils';

const REFRESH_OFF = 'off';

const REFRESH_OPTIONS = [
    { value: REFRESH_OFF, label: 'Off' },
    ...DASHBOARD_REFRESH_INTERVALS.map((interval) => ({
        value: interval,
        label: interval,
    })),
];

export type TimeRangePickerProps = {
    value: TimeRangeInput;
    onChange: (value: TimeRangeInput) => void;
    /** Current refresh interval; null is off. Only used with onRefreshIntervalChange. */
    refreshInterval?: DashboardRefreshInterval | null;
    /** Pass to offer the refresh options; omit when the caller cannot refresh. */
    onRefreshIntervalChange?: (value: DashboardRefreshInterval | null) => void;
    disabled?: boolean;
};

export const TimeRangePicker: FC<TimeRangePickerProps> = ({
    value,
    onChange,
    refreshInterval = null,
    onRefreshIntervalChange,
    disabled,
}) => {
    const [opened, setOpened] = useState(false);
    const [draft, setDraft] = useState<TimeRangeInput>(value);
    const [error, setError] = useState<string>();

    const open = () => {
        setDraft(value);
        setError(undefined);
        setOpened(true);
    };

    const choose = (range: TimeRangeInput) => {
        setOpened(false);
        onChange({ from: range.from, to: range.to });
    };

    const apply = (event: FormEvent) => {
        event.preventDefault();
        const range = { from: draft.from.trim(), to: draft.to.trim() };
        const message = getTimeRangeInputError(range);
        if (message) {
            setError(message);
            return;
        }
        choose(range);
    };

    return (
        <Group gap="xs" wrap="nowrap">
            <Popover
                opened={opened}
                onChange={setOpened}
                position="bottom-end"
                shadow="md"
                withinPortal
            >
                <Popover.Target>
                    <Button
                        size="xs"
                        variant="default"
                        disabled={disabled}
                        leftSection={<MantineIcon icon={IconClock} />}
                        onClick={() => (opened ? setOpened(false) : open())}
                    >
                        {getTimeRangeLabel(value)}
                    </Button>
                </Popover.Target>
                <Popover.Dropdown p="sm">
                    <Group align="flex-start" gap="md" wrap="nowrap">
                        <form onSubmit={apply}>
                            <Stack gap="xs" w={260}>
                                <Text fw={600} fz="sm">
                                    Absolute time range
                                </Text>
                                <TextInput
                                    size="xs"
                                    label="From"
                                    placeholder="2026-11-01T00:00:00Z or now-6h"
                                    value={draft.from}
                                    onChange={(event) =>
                                        setDraft({
                                            ...draft,
                                            from: event.currentTarget.value,
                                        })
                                    }
                                />
                                <TextInput
                                    size="xs"
                                    label="To"
                                    placeholder="2026-11-02T00:00:00Z or now"
                                    value={draft.to}
                                    onChange={(event) =>
                                        setDraft({
                                            ...draft,
                                            to: event.currentTarget.value,
                                        })
                                    }
                                />
                                {error && (
                                    <Text c="red" fz="xs">
                                        {error}
                                    </Text>
                                )}
                                <Group justify="flex-end">
                                    <Button size="xs" type="submit">
                                        Apply
                                    </Button>
                                </Group>
                            </Stack>
                        </form>
                        <Divider orientation="vertical" />
                        <Box>
                            <Stack gap={2} w={160}>
                                {QUICK_TIME_RANGES.map((range) => (
                                    <Button
                                        key={range.from}
                                        size="xs"
                                        variant={
                                            isSameTimeRange(range, value)
                                                ? 'light'
                                                : 'subtle'
                                        }
                                        justify="flex-start"
                                        onClick={() => choose(range)}
                                    >
                                        {getTimeRangeLabel(range)}
                                    </Button>
                                ))}
                            </Stack>
                        </Box>
                    </Group>
                </Popover.Dropdown>
            </Popover>
            {onRefreshIntervalChange && (
                <NativeSelect
                    size="xs"
                    aria-label="Refresh"
                    disabled={disabled}
                    data={REFRESH_OPTIONS}
                    value={refreshInterval ?? REFRESH_OFF}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        onRefreshIntervalChange(
                            isDashboardRefreshInterval(next) ? next : null,
                        );
                    }}
                />
            )}
        </Group>
    );
};
