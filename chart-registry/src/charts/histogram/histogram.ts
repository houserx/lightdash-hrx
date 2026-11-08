export type HistogramBucket = { from: number; to: number; count: number };

/**
 * Buckets finite values into `bucketCount` equal-width buckets spanning
 * [min, max]. Each bucket holds values in [from, to), the last one also
 * holds max. When every value is the same, the single value sits in a
 * one-wide range centred on it.
 */
export const bucketValues = (
    values: number[],
    bucketCount: number,
): HistogramBucket[] => {
    if (values.length === 0) return [];
    const count = Math.max(1, Math.floor(bucketCount));
    // A loop, not Math.min(...values): large results overflow the call stack.
    let min = values[0];
    let max = values[0];
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (min === max) {
        min -= 0.5;
        max += 0.5;
    }
    const width = (max - min) / count;
    const buckets: HistogramBucket[] = Array.from(
        { length: count },
        (_, i) => ({
            from: min + i * width,
            to: i === count - 1 ? max : min + (i + 1) * width,
            count: 0,
        }),
    );
    for (const value of values) {
        const index = Math.min(Math.floor((value - min) / width), count - 1);
        buckets[index].count += 1;
    }
    return buckets;
};
