// ENG-1799 demo: the fake Okta authorization server (served from the telemetry-fakes process on an ephemeral port;
// stack.json `okta.issuer`). telemetry-mcp checks bearer tokens against it exactly as against Okta: RS256 signature
// against the JWKS, `iss`, `aud`, `exp`. It holds one RSA key generated at start, so tokens die with the process.
//
// Issuer: http://127.0.0.1:<port>/oauth2/default (Okta's custom authorization server path).
//   GET  {issuer}/v1/keys                                  the JWKS (one RS256 key)
//   GET  {issuer}/.well-known/oauth-authorization-server   and /.well-known/openid-configuration: discovery
//   POST {issuer}/v1/token  {"email": "<email>"}            -> {access_token, token_type: "Bearer", expires_in}
//                                                            an access token for that email with aud OKTA_AUDIENCE.
//                                                            No password and no client: the demo's stand-in for the
//                                                            browser sign-in a real MCP client does at Okta.
//   GET  /ready                                            200 "ready".
// Telemetry-mcp maps the token's email to a Lightdash user; an email with no Lightdash user gets a session with no tools.
import crypto from 'node:crypto';
import type http from 'node:http';

/** The `aud` of every token, and telemetry-mcp's OKTA_AUDIENCE. */
export const OKTA_AUDIENCE = 'api://telemetry-mcp-demo';
export const OKTA_ISSUER_PATH = '/oauth2/default';
const TOKEN_TTL_SECONDS = 3600;
const MAX_BODY_BYTES = 16 * 1024;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export class FakeOkta {
    private readonly kid = `demo-${crypto.randomBytes(6).toString('hex')}`;

    private readonly privateKey: crypto.KeyObject;

    private readonly jwk: Record<string, unknown>;

    /** Set once the server listens: `http://127.0.0.1:<port>/oauth2/default`. Every token's `iss`. */
    issuer = '';

    constructor() {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        this.privateKey = privateKey;
        this.jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: this.kid, alg: 'RS256', use: 'sig' };
    }

    jwks(): { keys: Record<string, unknown>[] } {
        return { keys: [this.jwk] };
    }

    /** An RS256 access token for `email`. */
    issue(email: string): string {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
        const payload = {
            iss: this.issuer,
            aud: OKTA_AUDIENCE,
            sub: email,
            email,
            iat: now,
            exp: now + TOKEN_TTL_SECONDS,
            jti: b64url(crypto.randomBytes(12)),
        };
        const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
        return `${data}.${b64url(crypto.sign('sha256', Buffer.from(data), this.privateKey))}`;
    }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new Error('request body too large');
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

export function oktaHandler(okta: FakeOkta): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
        const { issuer } = okta;
        switch (route) {
            case 'GET /ready':
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('ready');
                return;
            case `GET ${OKTA_ISSUER_PATH}/v1/keys`:
                send(res, 200, okta.jwks());
                return;
            case `GET ${OKTA_ISSUER_PATH}/.well-known/oauth-authorization-server`:
            case `GET ${OKTA_ISSUER_PATH}/.well-known/openid-configuration`:
                send(res, 200, {
                    issuer,
                    jwks_uri: `${issuer}/v1/keys`,
                    token_endpoint: `${issuer}/v1/token`,
                    response_types_supported: ['code'],
                    id_token_signing_alg_values_supported: ['RS256'],
                });
                return;
            case `POST ${OKTA_ISSUER_PATH}/v1/token`:
                readJson(req).then(
                    (body) => {
                        const email = (body as { email?: unknown } | null)?.email;
                        if (typeof email !== 'string' || !EMAIL_SHAPE.test(email.trim())) {
                            send(res, 400, { error: 'invalid_request', error_description: 'body must be {"email": "<email>"}' });
                            return;
                        }
                        send(res, 200, {
                            access_token: okta.issue(email.trim()),
                            token_type: 'Bearer',
                            expires_in: TOKEN_TTL_SECONDS,
                        });
                    },
                    () => send(res, 400, { error: 'invalid_request', error_description: 'body must be JSON' }),
                );
                return;
            default:
                send(res, 404, { error: `no route ${route}` });
        }
    };
}
