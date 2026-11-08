import { getTelemetryResultShape } from './telemetryResultShape';

describe('getTelemetryResultShape', () => {
    it('ignores column order and case', () => {
        expect(getTelemetryResultShape(['LABELS', 'Value', 'timestamp'])).toBe(
            'metric',
        );
        expect(getTelemetryResultShape(['Line', 'TIMESTAMP'])).toBe('log');
        expect(getTelemetryResultShape(['TRACE_ID'])).toBe('trace');
    });

    it('needs every metric column', () => {
        expect(getTelemetryResultShape(['timestamp', 'value'])).toBe('table');
        expect(getTelemetryResultShape(['value', 'labels'])).toBe('table');
    });

    it('needs a timestamp for a log shape', () => {
        expect(getTelemetryResultShape(['line', 'labels'])).toBe('table');
        expect(getTelemetryResultShape(['message'])).toBe('table');
    });

    it('treats no columns as a table', () => {
        expect(getTelemetryResultShape([])).toBe('table');
    });
});
