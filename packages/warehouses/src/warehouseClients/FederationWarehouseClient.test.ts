import { DimensionType } from '@lightdash/common';
import { mapFederationFieldType } from './FederationWarehouseClient';

describe('mapFederationFieldType', () => {
    it.each([
        ['Timestamp(µs, "UTC")', DimensionType.TIMESTAMP],
        ['Timestamp(µs)', DimensionType.TIMESTAMP],
        ['Timestamp(Microsecond, Some("UTC"))', DimensionType.TIMESTAMP],
        ['Time64(µs)', DimensionType.TIMESTAMP],
        ['Date32', DimensionType.DATE],
        ['Int64', DimensionType.NUMBER],
        ['UInt32', DimensionType.NUMBER],
        ['Float64', DimensionType.NUMBER],
        ['Decimal128(38, 9)', DimensionType.NUMBER],
        ['Boolean', DimensionType.BOOLEAN],
        ['Utf8', DimensionType.STRING],
        ['Utf8View', DimensionType.STRING],
        ['LargeUtf8', DimensionType.STRING],
    ])('maps the Arrow type %s', (dataType, expected) => {
        expect(mapFederationFieldType(dataType)).toBe(expected);
    });

    it.each([
        ['timestamp with time zone', DimensionType.TIMESTAMP],
        ['bigint', DimensionType.NUMBER],
        ['boolean', DimensionType.BOOLEAN],
        ['date', DimensionType.DATE],
        ['text', DimensionType.STRING],
    ])('falls back to the Postgres mapping for %s', (dataType, expected) => {
        expect(mapFederationFieldType(dataType)).toBe(expected);
    });
});
