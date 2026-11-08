import {
    type ApiWriteRequest,
    type WriteConfirmation,
    type WriteResult,
} from '@lightdash/common';
import { Button, Code, Group, Paper, Stack, Text } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { type FC } from 'react';
import MantineIcon from '../../../components/common/MantineIcon';

/**
 * How Write Mode reaches Lightdash (CONTRACTS §4.2): a fresh single-statement confirmation
 * token for each Preview or Commit, then the write itself with that token.
 */
export type WriteModeApi = {
    createConfirmation: (statement: string) => Promise<WriteConfirmation>;
    write: (request: ApiWriteRequest) => Promise<WriteResult>;
};

export type WriteModePanelProps = {
    /** The Platform Database statement exactly as written in the Platform SQL box. */
    statement: string;
    api: WriteModeApi;
};

/**
 * Write Mode for one Platform Database statement: shows the statement Write Mode acts on, with
 * Preview. Preview is not wired yet (ldq-write-mode-preview), so it stays disabled.
 */
export const WriteModePanel: FC<WriteModePanelProps> = ({ statement }) => (
    <Paper withBorder p="sm" data-testid="write-mode-panel">
        <Stack gap="xs">
            <Text size="sm" fw={600}>
                Write Mode
            </Text>
            {statement.trim() === '' ? (
                <Text size="sm" c="dimmed">
                    Write a statement in the Platform SQL box.
                </Text>
            ) : (
                <Code block>{statement}</Code>
            )}
            <Group justify="flex-end">
                <Button
                    size="xs"
                    variant="default"
                    leftSection={<MantineIcon icon={IconEye} />}
                    disabled
                >
                    Preview
                </Button>
            </Group>
        </Stack>
    </Paper>
);
