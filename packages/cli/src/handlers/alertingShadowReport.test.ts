import { ParameterError, type ShadowRunReport } from '@lightdash/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    formatShadowReport,
    readExpectedDifferencesFile,
    readGrafanaHistoryFile,
} from './alertingShadowReport';

let dir: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-report-'));
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const write = async (name: string, text: string) => {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, text);
    return filePath;
};

describe('readExpectedDifferencesFile', () => {
    it('reads a YAML list', async () => {
        const filePath = await write(
            'e.yml',
            '- ruleName: Security group changed\n  kind: missing_in_lightdash\n  reason: not routed today\n',
        );
        await expect(readExpectedDifferencesFile(filePath)).resolves.toEqual([
            {
                ruleName: 'Security group changed',
                kind: 'missing_in_lightdash',
                reason: 'not routed today',
            },
        ]);
    });

    it('treats an empty file as no expected differences', async () => {
        const filePath = await write('e.yml', '');
        await expect(readExpectedDifferencesFile(filePath)).resolves.toEqual(
            [],
        );
    });

    it('rejects a document that is not a list', async () => {
        const filePath = await write('e.yml', 'ruleName: x\n');
        await expect(readExpectedDifferencesFile(filePath)).rejects.toThrow(
            ParameterError,
        );
    });
});

describe('readGrafanaHistoryFile', () => {
    it('rejects invalid JSON and names the file', async () => {
        const filePath = await write('h.json', '{not json');
        await expect(readGrafanaHistoryFile(filePath)).rejects.toThrow(
            filePath,
        );
    });

    it('rejects a missing file', async () => {
        await expect(
            readGrafanaHistoryFile(path.join(dir, 'missing.json')),
        ).rejects.toThrow(ParameterError);
    });
});

describe('formatShadowReport', () => {
    it('lists every rule name and marks expected and unexpected findings', () => {
        const report: ShadowRunReport = {
            matched: [
                {
                    ruleName: 'pg_cron job failed',
                    at: '2026-11-08T09:01:00Z',
                    lightdashAt: '2026-11-08T09:00:00Z',
                    deltaMs: -60_000,
                    labels: {},
                    expected: true,
                },
            ],
            missingInLightdash: [
                {
                    ruleName: 'ALB Unhealthy Hosts',
                    at: '2026-11-08T09:30:00Z',
                    labels: {},
                    expected: false,
                },
            ],
            extraInLightdash: [
                {
                    ruleName: 'Disk almost full',
                    at: '2026-11-08T10:00:00Z',
                    labels: {},
                    expected: true,
                    reason: 'new rule',
                },
            ],
            unexpectedCount: 1,
        };
        const text = formatShadowReport(report);
        expect(text).toContain('pg_cron job failed');
        expect(text).toContain('UNEXPECTED');
        expect(text).toContain('ALB Unhealthy Hosts');
        expect(text).toContain('Disk almost full');
        expect(text).toContain('(new rule)');
        expect(text).toContain('1 unexpected differences');
    });
});
