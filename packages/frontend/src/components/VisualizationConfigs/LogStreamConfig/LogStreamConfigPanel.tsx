import {
    DEFAULT_LOG_LEVEL_COLORS,
    isHexCodeColor,
    LOG_LEVELS,
    type LogLevel,
    type LogStreamChart,
} from '@lightdash/common';
import { ColorInput, Select, Stack, Switch } from '@mantine/core';
import { useEffect, useMemo, useState, type FC } from 'react';
import { Config } from '../common/Config';

/** A field the log stream can bind to. */
export type LogStreamConfigField = {
    id: string;
    label: string;
};

type Props = {
    config: LogStreamChart;
    fields: LogStreamConfigField[];
    onChange: (config: LogStreamChart) => void;
};

type FieldBindingKey =
    | 'lineFieldId'
    | 'timestampFieldId'
    | 'levelFieldId'
    | 'labelsFieldId';

const FIELD_BINDINGS: ReadonlyArray<{
    key: FieldBindingKey;
    label: string;
    description?: string;
}> = [
    { key: 'lineFieldId', label: 'Line field' },
    { key: 'timestampFieldId', label: 'Timestamp field' },
    {
        key: 'levelFieldId',
        label: 'Level field',
        description: 'Without one, the level comes from the labels',
    },
    { key: 'labelsFieldId', label: 'Labels field' },
];

const LEVEL_NAMES: Readonly<Record<LogLevel, string>> = {
    critical: 'Critical',
    error: 'Error',
    warning: 'Warning',
    info: 'Info',
    debug: 'Debug',
    trace: 'Trace',
    unknown: 'Unknown',
};

type LevelColorInputProps = {
    level: LogLevel;
    color: string | undefined;
    onChange: (level: LogLevel, color: string | undefined) => void;
};

/**
 * One level's colour. Shows the override, or the default when there is none.
 * A valid hex colour is saved as it is typed; clearing the input or choosing
 * the default removes the override, and anything invalid is put back on blur.
 */
const LevelColorInput: FC<LevelColorInputProps> = ({
    level,
    color,
    onChange,
}) => {
    const savedColor = color ?? DEFAULT_LOG_LEVEL_COLORS[level];
    const [draft, setDraft] = useState(savedColor);

    useEffect(() => {
        setDraft(savedColor);
    }, [savedColor]);

    const name = LEVEL_NAMES[level];

    return (
        <ColorInput
            size="xs"
            label={name}
            aria-label={`${name} colour`}
            format="hex"
            value={draft}
            placeholder={DEFAULT_LOG_LEVEL_COLORS[level]}
            onChange={(value) => {
                setDraft(value);
                if (value !== '' && !isHexCodeColor(value)) return;
                // The default colour is no override. ColorInput also calls
                // this on blur, so only report a real change.
                const next =
                    value === '' ||
                    value.toLowerCase() === DEFAULT_LOG_LEVEL_COLORS[level]
                        ? undefined
                        : value;
                if (next !== color) onChange(level, next);
            }}
            onBlur={() => {
                if (draft !== '' && !isHexCodeColor(draft)) {
                    setDraft(savedColor);
                }
            }}
        />
    );
};

/**
 * Config panel for a log stream chart: the field bindings, the display
 * toggles and the colour of each log level.
 */
export const LogStreamConfigPanel: FC<Props> = ({
    config,
    fields,
    onChange,
}) => {
    const fieldOptions = useMemo(
        () => fields.map((field) => ({ value: field.id, label: field.label })),
        [fields],
    );

    const update = (patch: Partial<LogStreamChart>) =>
        onChange({ ...config, ...patch });

    const setLevelColor = (level: LogLevel, color: string | undefined) => {
        const { [level]: _previous, ...rest } = config.levelColors ?? {};
        const levelColors =
            color === undefined ? rest : { ...rest, [level]: color };
        update({
            levelColors:
                Object.keys(levelColors).length > 0 ? levelColors : undefined,
        });
    };

    return (
        <Stack gap="md">
            <Config>
                <Config.Section>
                    <Config.Heading>Fields</Config.Heading>
                    {FIELD_BINDINGS.map(({ key, label, description }) => (
                        <Select
                            key={key}
                            size="xs"
                            label={label}
                            description={description}
                            placeholder="Detect automatically"
                            data={fieldOptions}
                            value={config[key] ?? null}
                            clearable
                            searchable
                            // Mount the options only while open, so the
                            // label names the picker alone.
                            comboboxProps={{ keepMounted: false }}
                            onChange={(value) =>
                                update({ [key]: value ?? undefined })
                            }
                        />
                    ))}
                </Config.Section>
            </Config>
            <Config>
                <Config.Section>
                    <Config.Heading>Display</Config.Heading>
                    <Switch
                        size="xs"
                        label="Wrap lines"
                        checked={config.wrapLines ?? false}
                        onChange={(event) =>
                            update({ wrapLines: event.currentTarget.checked })
                        }
                    />
                    <Switch
                        size="xs"
                        label="Newest first"
                        checked={config.newestFirst ?? true}
                        onChange={(event) =>
                            update({ newestFirst: event.currentTarget.checked })
                        }
                    />
                    <Switch
                        size="xs"
                        label="Show labels"
                        checked={config.showLabels ?? false}
                        onChange={(event) =>
                            update({ showLabels: event.currentTarget.checked })
                        }
                    />
                </Config.Section>
            </Config>
            <Config>
                <Config.Section>
                    <Config.Heading>Level colours</Config.Heading>
                    {LOG_LEVELS.map((level) => (
                        <LevelColorInput
                            key={level}
                            level={level}
                            color={config.levelColors?.[level]}
                            onChange={setLevelColor}
                        />
                    ))}
                </Config.Section>
            </Config>
        </Stack>
    );
};
