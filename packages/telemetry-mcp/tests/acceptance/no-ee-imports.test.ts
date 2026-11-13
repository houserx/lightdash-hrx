import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, PKG_DIR, REPO_ROOT, walk } from './helpers/files';

// The commit this line was cut from (docs(ENG-1799): observability design ...).
const BASE = '6855d0840';

describe('the package stays independent of packages/backend (and never touches ee)', () => {
    it('has source files', () => {
        expect(exists('src/index.ts')).toBe(true);
    });

    it('imports nothing from packages/backend, @lightdash/backend or any ee folder', () => {
        const files = walk('src').filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            const rel = path.relative(PKG_DIR, f);
            expect(src, rel).not.toMatch(/from\s+['"][^'"]*(packages\/backend|@lightdash\/backend|\/ee\/)/);
            expect(src, rel).not.toMatch(/require\(\s*['"][^'"]*(packages\/backend|@lightdash\/backend|\/ee\/)/);
        }
    });

    it('does not depend on @lightdash/backend', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
        const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        expect(Object.keys(all)).not.toContain('backend');
        expect(Object.keys(all)).not.toContain('@lightdash/backend');
    });

    it('leaves packages/backend/src/ee unchanged since the line began', () => {
        const committed = execFileSync('git', ['diff', '--name-only', BASE, '--', 'packages/backend/src/ee'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        const untracked = execFileSync(
            'git',
            ['ls-files', '--others', '--exclude-standard', '--', 'packages/backend/src/ee'],
            { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        expect(committed.trim()).toBe('');
        expect(untracked.trim()).toBe('');
    });
});
