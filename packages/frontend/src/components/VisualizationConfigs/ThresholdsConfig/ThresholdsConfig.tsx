import {
    GRAFANA_NAMED_COLORS,
    type CartesianThresholds,
    type CartesianThresholdsStyle,
    type GrafanaThresholdStep,
} from '@lightdash/common';
import {
    ActionIcon,
    Button,
    Group,
    NumberInput,
    Radio,
    SegmentedControl,
    Stack,
    Text,
} from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { type FC } from 'react';
import MantineIcon from '../../common/MantineIcon';
import ColorSelector from '../ColorSelector';
import { Config } from '../common/Config';

const STYLE_OPTIONS: { value: CartesianThresholdsStyle; label: string }[] = [
    { value: 'line', label: 'Line' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'area', label: 'Area' },
    { value: 'line+area', label: 'Line + area' },
    { value: 'dashed+area', label: 'Dashed + area' },
];

// Grafana's base hues, offered as swatches and cycled through for new steps
const SWATCHES = ['green', 'yellow', 'orange', 'red', 'blue', 'purple'].map(
    (name) => GRAFANA_NAMED_COLORS[name],
);

const BASE_STEP: GrafanaThresholdStep = {
    value: null,
    color: GRAFANA_NAMED_COLORS.green,
};

// Grafana's default thresholds for a new panel: green base, red at 80
const DEFAULT_THRESHOLDS: CartesianThresholds = {
    mode: 'absolute',
    style: 'line',
    steps: [BASE_STEP, { value: 80, color: GRAFANA_NAMED_COLORS.red }],
};

const STEP_GAP = 10;

// Adds a step above the highest one, or Grafana's defaults when there are none
const withAddedStep = (
    thresholds: CartesianThresholds | undefined,
): CartesianThresholds => {
    if (!thresholds) return DEFAULT_THRESHOLDS;
    const values = thresholds.steps
        .map((step) => step.value)
        .filter((value): value is number => value !== null);
    const value = values.length > 0 ? Math.max(...values) + STEP_GAP : 80;
    const hasBase = thresholds.steps.some((step) => step.value === null);
    const color = SWATCHES[thresholds.steps.length % SWATCHES.length];
    return {
        ...thresholds,
        steps: [
            ...(hasBase ? [] : [BASE_STEP]),
            ...thresholds.steps,
            { value, color },
        ],
    };
};

type Props = {
    thresholds: CartesianThresholds | undefined;
    onChange: (thresholds: CartesianThresholds) => void;
};

/**
 * Edits a cartesian chart's Grafana-style thresholds: the steps (the base
 * step, value null, can be recoloured but not removed or moved), whether
 * step values are absolute or percentages, and how they are drawn.
 */
export const ThresholdsConfig: FC<Props> = ({ thresholds, onChange }) => {
    const steps = thresholds?.steps ?? [];

    const updateStep = (
        index: number,
        patch: Partial<GrafanaThresholdStep>,
    ) => {
        if (!thresholds) return;
        onChange({
            ...thresholds,
            steps: steps.map((step, i) =>
                i === index ? { ...step, ...patch } : step,
            ),
        });
    };

    const removeStep = (index: number) => {
        if (!thresholds) return;
        onChange({
            ...thresholds,
            steps: steps.filter((_, i) => i !== index),
        });
    };

    return (
        <Config>
            <Config.Section>
                <Config.Group>
                    <Config.Heading>Thresholds</Config.Heading>
                    <Button
                        size="compact-sm"
                        variant="subtle"
                        leftSection="+"
                        onClick={() => onChange(withAddedStep(thresholds))}
                    >
                        Add threshold
                    </Button>
                </Config.Group>

                {steps.map((step, index) => {
                    const label = `Threshold ${index + 1}`;
                    return (
                        <Group key={index} gap="xs" wrap="nowrap">
                            <ColorSelector
                                color={step.color}
                                swatches={SWATCHES}
                                ariaLabel={`${label} colour`}
                                onColorChange={(color) =>
                                    updateStep(index, { color })
                                }
                            />
                            {step.value === null ? (
                                <Text fz="xs" c="dimmed" flex={1}>
                                    Base
                                </Text>
                            ) : (
                                <NumberInput
                                    size="xs"
                                    flex={1}
                                    aria-label={`${label} value`}
                                    value={step.value}
                                    onChange={(value) => {
                                        if (typeof value === 'number') {
                                            updateStep(index, { value });
                                        }
                                    }}
                                />
                            )}
                            {step.value !== null && (
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    aria-label={`Remove threshold ${index + 1}`}
                                    onClick={() => removeStep(index)}
                                >
                                    <MantineIcon icon={IconTrash} />
                                </ActionIcon>
                            )}
                        </Group>
                    );
                })}

                {thresholds && (
                    <Stack gap="xs">
                        <Group gap="xs">
                            <Config.Label>Mode</Config.Label>
                            <SegmentedControl
                                size="xs"
                                value={thresholds.mode ?? 'absolute'}
                                data={[
                                    { label: 'Absolute', value: 'absolute' },
                                    {
                                        label: 'Percentage',
                                        value: 'percentage',
                                    },
                                ]}
                                onChange={(mode) =>
                                    onChange({
                                        ...thresholds,
                                        mode: mode as CartesianThresholds['mode'],
                                    })
                                }
                            />
                        </Group>
                        <Radio.Group
                            label={
                                <Config.Label>Show thresholds as</Config.Label>
                            }
                            value={thresholds.style}
                            onChange={(style) =>
                                onChange({
                                    ...thresholds,
                                    style: style as CartesianThresholdsStyle,
                                })
                            }
                        >
                            <Stack gap={6} mt={4}>
                                {STYLE_OPTIONS.map((option) => (
                                    <Radio
                                        key={option.value}
                                        size="xs"
                                        value={option.value}
                                        label={option.label}
                                    />
                                ))}
                            </Stack>
                        </Radio.Group>
                    </Stack>
                )}
            </Config.Section>
        </Config>
    );
};
