import { type AlertInstanceState } from '@lightdash/common';
import { Badge, type MantineColor } from '@mantine/core';
import { type FC } from 'react';
import { ALERT_STATE_LABELS } from '../utils';

const ALERT_STATE_COLORS: Record<AlertInstanceState, MantineColor> = {
    firing: 'red',
    pending: 'yellow',
    normal: 'green',
    resolved: 'teal',
    nodata: 'gray',
    error: 'orange',
};

export const AlertStateBadge: FC<{ state: AlertInstanceState }> = ({
    state,
}) => (
    <Badge color={ALERT_STATE_COLORS[state]} variant="light" radius="sm">
        {ALERT_STATE_LABELS[state]}
    </Badge>
);

/** Shown on rules, Contact Points and route trees uploaded as code. */
export const ManagedInGitBadge: FC = () => (
    <Badge color="violet" variant="outline" radius="sm">
        Managed in git
    </Badge>
);
