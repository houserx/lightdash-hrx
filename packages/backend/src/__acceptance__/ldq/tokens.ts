/**
 * Independent reader for CONTRACTS §3 tokens:
 * <base64url(payload_json)>.<base64url(HMAC-SHA256(secret, base64url(payload_json)))>
 * Used to check what the implementation minted without trusting its own code.
 */
import { createHmac } from 'node:crypto';

export const TEST_SECRET = 'test-secret-not-real';

export const decodeToken = (token: string): any => {
    const [payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
};

export const hasValidSignature = (token: string, secret = TEST_SECRET) => {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const expected = createHmac('sha256', secret)
        .update(parts[0])
        .digest('base64url');
    return expected === parts[1];
};

export const signPayload = (payload: unknown, secret = TEST_SECRET) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret)
        .update(encoded)
        .digest('base64url');
    return `${encoded}.${signature}`;
};
