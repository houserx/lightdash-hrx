/**
 * The iframe side of the data-app viz protocol, without React: the same
 * handshake `@lightdash/query-sdk`'s `useVizContext` runs
 * (packages/query-sdk/src/vizContext.ts). Listen for the host's
 * `lightdash:sdk:data-app-viz-context` push, ask for it once with
 * `lightdash:sdk:viz-context-request`, and acknowledge each painted push
 * with `lightdash:sdk:viz-rendered`.
 */

const VIZ_CONTEXT_MESSAGE = 'lightdash:sdk:data-app-viz-context';
const VIZ_CONTEXT_REQUEST_MESSAGE = 'lightdash:sdk:viz-context-request';
const VIZ_RENDERED_MESSAGE = 'lightdash:sdk:viz-rendered';

export type VizCell = { value?: { raw?: unknown; formatted?: string } };

export type VizRow = Record<string, VizCell | undefined>;

export type VizContext = {
    type: typeof VIZ_CONTEXT_MESSAGE;
    fieldMapping: Record<string, string | string[] | undefined>;
    fields?: Record<string, { label: string }>;
    rows: VizRow[];
    options?: Record<string, unknown>;
    colorPalette?: string[];
    renderId?: string;
};

const isVizContext = (data: unknown): data is VizContext =>
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === VIZ_CONTEXT_MESSAGE &&
    Array.isArray((data as { rows?: unknown }).rows);

/** The query field id a viz field is bound to (first one for multi-field slots). */
export const boundFieldId = (
    context: VizContext,
    fieldName: string,
): string | undefined => {
    const bound = context.fieldMapping?.[fieldName];
    return Array.isArray(bound) ? bound[0] : bound;
};

/** Raw value of a viz field in a row, or undefined when the field is unbound. */
export const rawValue = (
    context: VizContext,
    row: VizRow,
    fieldName: string,
): unknown => {
    const id = boundFieldId(context, fieldName);
    return id === undefined ? undefined : row[id]?.value?.raw;
};

/** A finite number from a raw cell value (numeric strings included), else null. */
export const toNumber = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/** A config option value, falling back when it is missing or the wrong type. */
export function option(
    context: VizContext,
    name: string,
    fallback: number,
): number;
export function option(
    context: VizContext,
    name: string,
    fallback: string,
): string;
export function option(
    context: VizContext,
    name: string,
    fallback: boolean,
): boolean;
export function option(
    context: VizContext,
    name: string,
    fallback: number | string | boolean,
): number | string | boolean {
    const value = context.options?.[name];
    return typeof value === typeof fallback
        ? (value as typeof fallback)
        : fallback;
}

/**
 * Calls `render` with every viz context the host pushes, after asking the
 * host for the current one. Each painted render is acknowledged after two
 * animation frames, as the SDK does.
 */
export const onVizContext = (render: (context: VizContext) => void): void => {
    window.addEventListener('message', (event: MessageEvent) => {
        if (!isVizContext(event.data)) return;
        const context = event.data;
        render(context);
        const { renderId } = context;
        requestAnimationFrame(() =>
            requestAnimationFrame(() =>
                window.parent?.postMessage(
                    { type: VIZ_RENDERED_MESSAGE, renderId },
                    '*',
                ),
            ),
        );
    });
    window.parent?.postMessage({ type: VIZ_CONTEXT_REQUEST_MESSAGE }, '*');
};
