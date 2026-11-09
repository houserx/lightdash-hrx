/**
 * The small CBOR (RFC 8949) codec the AWS fakes need for Smithy RPC v2 CBOR, the protocol the
 * engine's AWS SDK clients speak (e.g. aws-sdk-cloudwatch 1.140). No CBOR library is in the
 * lockfile.
 *
 * Decoding gives plain JS values: maps → objects (text keys), arrays → arrays, byte strings →
 * `Buffer`, tag 1 (epoch-seconds timestamp) and every other tag → the tagged value, integers →
 * numbers (or `bigint` beyond 2^53), floats (half/single/double) → numbers, undefined → null.
 * Indefinite-length strings, arrays and maps are accepted.
 *
 * Encoding is the inverse for what replies carry, with two markers: `cborTimestamp(seconds)`
 * becomes tag 1 over a double, `cborDouble(n)` forces a double (for `Double` members whose value
 * happens to be integral). Other integral numbers encode as integers, others as doubles.
 */

const TIMESTAMP = Symbol('cbor-timestamp');
const DOUBLE = Symbol('cbor-double');

export type CborTimestamp = { [TIMESTAMP]: number };
export type CborDouble = { [DOUBLE]: number };

/** An AWS timestamp (tag 1, epoch seconds as a double). */
export const cborTimestamp = (epochSeconds: number): CborTimestamp => ({
    [TIMESTAMP]: epochSeconds,
});

/** A number always encoded as a double. */
export const cborDouble = (value: number): CborDouble => ({ [DOUBLE]: value });

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

const BREAK = Symbol('cbor-break');

class Decoder {
    private offset = 0;

    constructor(private readonly bytes: Buffer) {}

    decodeAll(): unknown {
        const value = this.item();
        if (value === BREAK) throw new Error('cbor: unexpected break');
        if (this.offset !== this.bytes.length) {
            throw new Error(
                `cbor: ${this.bytes.length - this.offset} trailing bytes`,
            );
        }
        return value;
    }

    private need(n: number) {
        if (this.offset + n > this.bytes.length) {
            throw new Error('cbor: truncated input');
        }
    }

    private byte(): number {
        this.need(1);
        const b = this.bytes[this.offset];
        this.offset += 1;
        return b;
    }

    /** The argument of an initial byte; `null` for indefinite length (info 31). */
    private argument(info: number): number | bigint | null {
        if (info < 24) return info;
        let value: number | bigint;
        switch (info) {
            case 24:
                return this.byte();
            case 25:
                this.need(2);
                value = this.bytes.readUInt16BE(this.offset);
                this.offset += 2;
                return value;
            case 26:
                this.need(4);
                value = this.bytes.readUInt32BE(this.offset);
                this.offset += 4;
                return value;
            case 27: {
                this.need(8);
                const big = this.bytes.readBigUInt64BE(this.offset);
                this.offset += 8;
                return big <= BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number(big)
                    : big;
            }
            case 31:
                return null;
            default:
                throw new Error(`cbor: reserved additional info ${info}`);
        }
    }

    private length(info: number): number | null {
        const n = this.argument(info);
        if (typeof n === 'bigint') throw new Error('cbor: length too large');
        return n;
    }

    private chunks(major: number, info: number): Buffer {
        const n = this.length(info);
        if (n !== null) {
            this.need(n);
            const out = this.bytes.subarray(this.offset, this.offset + n);
            this.offset += n;
            return out;
        }
        const parts: Buffer[] = [];
        for (;;) {
            const initial = this.byte();
            if (initial === 0xff) break;
            if (initial >> 5 !== major || (initial & 31) === 31) {
                throw new Error('cbor: bad chunk in indefinite string');
            }
            parts.push(this.chunks(major, initial & 31));
        }
        return Buffer.concat(parts);
    }

    private item(): unknown {
        const initial = this.byte();
        const major = initial >> 5;
        const info = initial & 31;
        switch (major) {
            case 0:
                if (info === 31) throw new Error('cbor: bad integer');
                return this.argument(info);
            case 1: {
                const n = this.argument(info);
                if (n === null) throw new Error('cbor: bad integer');
                return typeof n === 'bigint' ? -1n - n : -1 - n;
            }
            case 2:
                return Buffer.from(this.chunks(2, info));
            case 3:
                return this.chunks(3, info).toString('utf8');
            case 4: {
                const n = this.length(info);
                const out: unknown[] = [];
                for (let i = 0; n === null || i < n; i += 1) {
                    const value = this.item();
                    if (value === BREAK) {
                        if (n !== null) throw new Error('cbor: unexpected break');
                        break;
                    }
                    out.push(value);
                }
                return out;
            }
            case 5: {
                const n = this.length(info);
                const out: Record<string, unknown> = {};
                for (let i = 0; n === null || i < n; i += 1) {
                    const key = this.item();
                    if (key === BREAK) {
                        if (n !== null) throw new Error('cbor: unexpected break');
                        break;
                    }
                    const value = this.item();
                    if (value === BREAK) throw new Error('cbor: map without value');
                    out[String(key)] = value;
                }
                return out;
            }
            case 6:
                this.argument(info);
                return this.item();
            default:
                return this.simple(info);
        }
    }

    private simple(info: number): unknown {
        switch (info) {
            case 20:
                return false;
            case 21:
                return true;
            case 22:
            case 23:
                return null;
            case 25: {
                this.need(2);
                const half = this.bytes.readUInt16BE(this.offset);
                this.offset += 2;
                return halfToNumber(half);
            }
            case 26: {
                this.need(4);
                const value = this.bytes.readFloatBE(this.offset);
                this.offset += 4;
                return value;
            }
            case 27: {
                this.need(8);
                const value = this.bytes.readDoubleBE(this.offset);
                this.offset += 8;
                return value;
            }
            case 31:
                return BREAK;
            default:
                if (info < 24) return null;
                if (info === 24) {
                    this.byte();
                    return null;
                }
                throw new Error(`cbor: bad simple value ${info}`);
        }
    }
}

function halfToNumber(half: number): number {
    const sign = half & 0x8000 ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const fraction = half & 0x3ff;
    if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Decodes one CBOR data item that fills `bytes`. Throws on malformed input. */
export function decodeCbor(bytes: Buffer): unknown {
    return new Decoder(bytes).decodeAll();
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

function head(major: number, n: number | bigint): Buffer {
    const m = major << 5;
    if (typeof n === 'number' && n < 24) return Buffer.from([m | n]);
    if (typeof n === 'number' && n < 0x100) return Buffer.from([m | 24, n]);
    if (typeof n === 'number' && n < 0x10000) {
        const b = Buffer.alloc(3);
        b[0] = m | 25;
        b.writeUInt16BE(n, 1);
        return b;
    }
    if (typeof n === 'number' && n < 0x100000000) {
        const b = Buffer.alloc(5);
        b[0] = m | 26;
        b.writeUInt32BE(n, 1);
        return b;
    }
    const b = Buffer.alloc(9);
    b[0] = m | 27;
    b.writeBigUInt64BE(BigInt(n), 1);
    return b;
}

function double(value: number): Buffer {
    const b = Buffer.alloc(9);
    b[0] = 0xfb;
    b.writeDoubleBE(value, 1);
    return b;
}

function encodeInto(value: unknown, out: Buffer[]): void {
    if (value === null || value === undefined) {
        out.push(Buffer.from([0xf6]));
    } else if (typeof value === 'boolean') {
        out.push(Buffer.from([value ? 0xf5 : 0xf4]));
    } else if (typeof value === 'number') {
        if (Number.isSafeInteger(value)) {
            out.push(value >= 0 ? head(0, value) : head(1, -1 - value));
        } else {
            out.push(double(value));
        }
    } else if (typeof value === 'bigint') {
        out.push(value >= 0n ? head(0, value) : head(1, -1n - value));
    } else if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        out.push(head(3, bytes.length), bytes);
    } else if (Buffer.isBuffer(value)) {
        out.push(head(2, value.length), value);
    } else if (Array.isArray(value)) {
        out.push(head(4, value.length));
        for (const item of value) encodeInto(item, out);
    } else if (typeof value === 'object' && TIMESTAMP in value) {
        out.push(head(6, 1), double((value as CborTimestamp)[TIMESTAMP]));
    } else if (typeof value === 'object' && DOUBLE in value) {
        out.push(double((value as CborDouble)[DOUBLE]));
    } else if (typeof value === 'object') {
        const entries = Object.entries(value).filter(
            ([, v]) => v !== undefined,
        );
        out.push(head(5, entries.length));
        for (const [key, item] of entries) {
            encodeInto(key, out);
            encodeInto(item, out);
        }
    } else {
        throw new Error(`cbor: cannot encode ${typeof value}`);
    }
}

/** Encodes `value` as one CBOR data item (definite lengths). */
export function encodeCbor(value: unknown): Buffer {
    const out: Buffer[] = [];
    encodeInto(value, out);
    return Buffer.concat(out);
}
