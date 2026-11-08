import { Anchor, Code, Group, Stack, Text } from '@mantine/core';
import { type FC } from 'react';

type Props = {
    /** The plan as Postgres returned it (EXPLAIN (FORMAT JSON)). */
    plan: unknown;
    /** The same plan in Postgres' text layout. */
    text: string;
};

const dataUrl = (mimeType: string, content: string) =>
    `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;

/** An estimate-only query plan as text, with the plan downloadable as JSON or as text. */
export const ExplainPlan: FC<Props> = ({ plan, text }) => (
    <Stack gap="xs" data-testid="investigate-explain-plan">
        <Group justify="space-between">
            <Text size="sm" fw={500}>
                Estimated plan
            </Text>
            <Group gap="sm">
                <Anchor
                    size="xs"
                    href={dataUrl(
                        'application/json',
                        JSON.stringify(plan, null, 2),
                    )}
                    download="explain-plan.json"
                >
                    Download JSON
                </Anchor>
                <Anchor
                    size="xs"
                    href={dataUrl('text/plain', text)}
                    download="explain-plan.txt"
                >
                    Download text
                </Anchor>
            </Group>
        </Group>
        <Code block>{text}</Code>
    </Stack>
);
