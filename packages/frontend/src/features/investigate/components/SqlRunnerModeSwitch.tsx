import { isFederationProject } from '@lightdash/common';
import { SegmentedControl } from '@mantine/core';
import { type FC } from 'react';

/** The SQL Runner's modes: plain SQL, or Investigate on federation projects. */
export type SqlRunnerMode = 'sql' | 'investigate';

const MODE_OPTIONS: { value: SqlRunnerMode; label: string }[] = [
    { value: 'sql', label: 'SQL' },
    { value: 'investigate', label: 'Investigate' },
];

type Props = {
    project: Parameters<typeof isFederationProject>[0];
    mode: SqlRunnerMode;
    onModeChange: (mode: SqlRunnerMode) => void;
};

/**
 * Switches the SQL Runner between SQL and Investigate. Investigate is only offered on
 * federation projects (Postgres credentials with flavor 'federation', CONTRACTS §4.1);
 * on any other project nothing is rendered.
 */
export const SqlRunnerModeSwitch: FC<Props> = ({
    project,
    mode,
    onModeChange,
}) => {
    if (!isFederationProject(project)) return null;

    return (
        <SegmentedControl
            size="xs"
            aria-label="SQL Runner mode"
            data={MODE_OPTIONS}
            value={mode}
            onChange={(value) => onModeChange(value as SqlRunnerMode)}
        />
    );
};
