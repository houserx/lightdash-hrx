// ENG-1799 demo: the throwaway Postgres that plays the Platform Database.
//
//   node --import tsx stack/platform-db.ts prepare --dir <.state/platform-db>
//       Creates a fresh cluster in <dir>/pgdata (any earlier one is removed: every up.sh starts from the same
//       synthetic data), listening on 127.0.0.1 only at a free port with no unix socket, and prints the port.
//   node --import tsx stack/platform-db.ts seed --port <port> --pid <postgres pid> --ready-file <file>
//       Waits until that server accepts connections, creates the read/write roles and the synthetic pharmacy
//       operations schema (orders, fills, queues, shipments), then writes the ready file atomically:
//       {"platformDb": {host, port, user, password, database, roles: {read: {user, password}, write: {...}}}}.
//
// up.sh runs `postgres -D <dir>/pgdata` itself (its own process group, pid in stack.json) between the two steps.
// Every row is synthetic: names, contacts and identifiers say demo/example/fake, and there are no patient columns.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const PLATFORM_DB_HOST = '127.0.0.1';
const PLATFORM_DB_DATABASE = 'platform';
/** The demo's admin login (superuser of a throwaway cluster); stack.json `platformDb.user`. */
const PLATFORM_DB_ADMIN = { user: 'demo_admin', password: 'demo-admin-password-not-real' } as const;
/** The roles the Federation Engine uses for Audited Queries (read) and Write Mode (write). */
const PLATFORM_DB_ROLES = {
    read: { user: 'engine_read', password: 'demo-read-password-not-real' },
    write: { user: 'engine_write', password: 'demo-write-password-not-real' },
} as const;

const PG_BIN = process.env.DEMO_PG_BIN ?? (existsSync('/opt/homebrew/bin/initdb') ? '/opt/homebrew/bin' : '');
const pgBin = (name: string) => (PG_BIN ? path.join(PG_BIN, name) : name);

const READY_TIMEOUT_MS = 30_000;

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, PLATFORM_DB_HOST, () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
    });
}

async function prepare(dir: string): Promise<void> {
    const data = path.join(dir, 'pgdata');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const pwfile = path.join(dir, 'pwfile');
    writeFileSync(pwfile, PLATFORM_DB_ADMIN.password, { mode: 0o600 });
    try {
        execFileSync(
            pgBin('initdb'),
            [
                '-D',
                data,
                '-U',
                PLATFORM_DB_ADMIN.user,
                '-A',
                'scram-sha-256',
                '-E',
                'UTF8',
                '--locale=C',
                '--no-sync',
                `--pwfile=${pwfile}`,
            ],
            { stdio: ['ignore', 'ignore', 'inherit'] },
        );
    } finally {
        rmSync(pwfile, { force: true });
    }
    const port = await freePort();
    appendFileSync(
        path.join(data, 'postgresql.conf'),
        [
            '',
            '# ENG-1799 demo Platform Database (throwaway)',
            `port = ${port}`,
            `listen_addresses = '${PLATFORM_DB_HOST}'`,
            "unix_socket_directories = ''",
            'fsync = off',
            'synchronous_commit = off',
            'full_page_writes = off',
            'max_connections = 50',
            '',
        ].join('\n'),
    );
    console.log(port);
}

const CREATE_DATABASE_SQL = `CREATE DATABASE ${PLATFORM_DB_DATABASE}`;

// Synthetic pharmacy operations schema. Timestamps are relative to the moment of seeding so the data looks recent.
const SEED_SQL = `
CREATE ROLE ${PLATFORM_DB_ROLES.read.user} LOGIN PASSWORD '${PLATFORM_DB_ROLES.read.password}';
CREATE ROLE ${PLATFORM_DB_ROLES.write.user} LOGIN PASSWORD '${PLATFORM_DB_ROLES.write.password}';

CREATE TABLE public.queues (
    id int PRIMARY KEY,
    name text NOT NULL UNIQUE,
    stage text NOT NULL,
    site text NOT NULL,
    target_minutes int NOT NULL
);
INSERT INTO public.queues (id, name, stage, site, target_minutes) VALUES
    (1, 'demo-intake', 'intake', 'demo-site-east', 30),
    (2, 'demo-fill', 'fill', 'demo-site-east', 60),
    (3, 'demo-verification', 'verification', 'demo-site-east', 45),
    (4, 'demo-shipping', 'shipping', 'demo-site-west', 120);

CREATE TABLE public.orders (
    id int PRIMARY KEY,
    order_number text NOT NULL UNIQUE,
    customer_name text NOT NULL,
    customer_email text NOT NULL,
    item_name text NOT NULL,
    quantity int NOT NULL,
    status text NOT NULL,
    priority text NOT NULL,
    created_at timestamptz NOT NULL
);
INSERT INTO public.orders
SELECT g,
       'DEMO-ORD-' || lpad(g::text, 5, '0'),
       'Demo Customer ' || g,
       'demo.customer' || g || '@example.com',
       'Example item ' || chr(65 + g % 6),
       1 + g % 3,
       (ARRAY['received', 'in_fill', 'filled', 'shipped', 'delivered'])[1 + g % 5],
       CASE WHEN g % 10 = 0 THEN 'urgent' ELSE 'standard' END,
       now() - make_interval(mins => (120 - g) * 30)
FROM generate_series(1, 120) AS g;

CREATE TABLE public.fills (
    id int PRIMARY KEY,
    order_id int NOT NULL REFERENCES public.orders (id),
    queue_id int NOT NULL REFERENCES public.queues (id),
    technician_name text NOT NULL,
    status text NOT NULL,
    queued_at timestamptz NOT NULL,
    completed_at timestamptz
);
INSERT INTO public.fills
SELECT o.id,
       o.id,
       CASE o.status WHEN 'received' THEN 1 WHEN 'in_fill' THEN 2 WHEN 'filled' THEN 3 ELSE 4 END,
       'Demo Technician ' || (1 + o.id % 8),
       CASE WHEN o.status IN ('received', 'in_fill') THEN 'queued' ELSE 'completed' END,
       o.created_at + interval '5 minutes',
       CASE WHEN o.status IN ('received', 'in_fill') THEN NULL
            ELSE o.created_at + make_interval(mins => 20 + o.id % 50) END
FROM public.orders o;

CREATE TABLE public.shipments (
    id int PRIMARY KEY,
    order_id int NOT NULL REFERENCES public.orders (id),
    carrier text NOT NULL,
    tracking_number text NOT NULL UNIQUE,
    ship_to_name text NOT NULL,
    ship_to_address text NOT NULL,
    status text NOT NULL,
    shipped_at timestamptz NOT NULL,
    delivered_at timestamptz
);
INSERT INTO public.shipments
SELECT o.id,
       o.id,
       (ARRAY['Example Parcel', 'Demo Courier'])[1 + o.id % 2],
       'FAKE-TRK-' || lpad(o.id::text, 6, '0'),
       'Demo Customer ' || o.id,
       (100 + o.id) || ' Example Street, Demo City, ZZ 00000',
       CASE o.status WHEN 'delivered' THEN 'delivered' ELSE 'in_transit' END,
       o.created_at + interval '2 hours',
       CASE o.status WHEN 'delivered' THEN o.created_at + interval '26 hours' END
FROM public.orders o
WHERE o.status IN ('filled', 'shipped', 'delivered');

GRANT USAGE ON SCHEMA public TO ${PLATFORM_DB_ROLES.read.user}, ${PLATFORM_DB_ROLES.write.user};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${PLATFORM_DB_ROLES.read.user};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_DB_ROLES.write.user};
`;

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function adminQuery(port: number, database: string, sql: string): Promise<void> {
    const client = new pg.Client({ host: PLATFORM_DB_HOST, port, database, ...PLATFORM_DB_ADMIN, ssl: false });
    client.on('error', () => undefined);
    try {
        await client.connect();
        await client.query(sql);
    } finally {
        await client.end().catch(() => undefined);
    }
}

async function seed(port: number, pid: number, readyFile: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (!processAlive(pid)) throw new Error(`postgres (pid ${pid}) exited before accepting connections`);
        try {
            // eslint-disable-next-line no-await-in-loop
            await adminQuery(port, 'postgres', 'SELECT 1');
            break;
        } catch (e) {
            if (Date.now() > deadline) throw e;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
            setTimeout(r, 100);
        });
    }
    await adminQuery(port, 'postgres', CREATE_DATABASE_SQL);
    await adminQuery(port, PLATFORM_DB_DATABASE, `BEGIN;\n${SEED_SQL}\nCOMMIT;`);

    const ready = {
        platformDb: {
            host: PLATFORM_DB_HOST,
            port,
            ...PLATFORM_DB_ADMIN,
            database: PLATFORM_DB_DATABASE,
            roles: PLATFORM_DB_ROLES,
        },
    };
    writeFileSync(`${readyFile}.tmp`, `${JSON.stringify(ready, null, 2)}\n`);
    renameSync(`${readyFile}.tmp`, readyFile);
}

function fail(message: string): never {
    console.error(`platform-db: ${message}`);
    process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
    args: rest,
    options: {
        dir: { type: 'string' },
        port: { type: 'string' },
        pid: { type: 'string' },
        'ready-file': { type: 'string' },
    },
});

let work: Promise<void>;
if (command === 'prepare') {
    if (!args.dir) fail('prepare needs --dir');
    work = prepare(args.dir);
} else if (command === 'seed') {
    const port = Number(args.port);
    const pid = Number(args.pid);
    if (!Number.isInteger(port) || port <= 0) fail('seed needs --port <port>');
    if (!Number.isInteger(pid) || pid <= 0) fail('seed needs --pid <postgres pid>');
    if (!args['ready-file']) fail('seed needs --ready-file');
    work = seed(port, pid, args['ready-file']);
} else {
    fail('usage: platform-db.ts prepare --dir <dir> | seed --port <port> --pid <pid> --ready-file <file>');
}
work.catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
