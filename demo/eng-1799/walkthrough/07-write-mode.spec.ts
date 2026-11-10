// Scene 7: write mode. The on-call engineer raises the demo-fill queue's target time on the Platform Database while
// the fill queue is backed up. The scene opens Investigate in the SQL Runner, picks Platform Database, writes an
// UPDATE ... RETURNING statement and turns Write Mode on (offered because the demo user has platform_write).
//
// Preview first: the engine runs the statement in a transaction it always rolls back, and the panel shows "Rolled
// back" with the returned row. Then the user types COMMIT, and Commit changes the row for real ("Committed"). Both
// runs are Audited Queries in write mode with the same description. The scene ends in the audit browser (the
// "Audit browser" link next to the mode switch), filtered to the demo user, where the commit and the preview are the
// two newest records.
//
// The statement adds 15 minutes to the target, so every run changes the Platform Database again; a fresh up.sh
// reseeds it. The scene does not depend on the scenario clock and never restarts it.
//
// Key moment: the audit browser with both write records of this run.
import { beat, expect, QUERY_ERROR_TEXT, signIn, test } from './lib/scene';

const STATEMENT = "UPDATE queues SET target_minutes = target_minutes + 15 WHERE name = 'demo-fill' RETURNING name, target_minutes";

test.describe.configure({ timeout: 300_000 });

test('07-write-mode: Write Mode on the Platform Database, Preview, a confirmed commit and the audit browser', async ({
    page,
    scene,
    stack,
}) => {
    const description = `Raise the demo-fill target during the backlog (walkthrough ${new Date().toISOString().slice(11, 19)} UTC)`;

    await signIn(page, stack);
    await page.goto(`${stack.lightdash.url}/projects/${stack.lightdash.projectUuid}/home`);

    // New -> Query using SQL runner -> Investigate, as in scene 5.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: /Query using SQL runner/ }).click();
    await page.waitForURL(/\/sql-runner$/);
    await page.getByText('Investigate', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Investigate' }), 'the SQL Runner is in Investigate mode').toBeChecked();
    await beat(page);

    // The Platform Database source and the statement, typed as a user would.
    await page.getByText('Platform Database', { exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Platform Database' })).toBeChecked();
    const platformSql = page.getByRole('textbox', { name: 'Platform SQL' });
    await platformSql.click();
    await platformSql.pressSequentially(STATEMENT, { delay: 20 });
    await expect(platformSql).toHaveValue(STATEMENT);
    await beat(page);

    // Write Mode: the panel replaces Run and Explain and shows the statement it will write.
    const writeMode = page.getByRole('switch', { name: 'Write Mode' });
    await expect(writeMode, 'Write Mode is offered to a user with platform_write').toBeVisible();
    await writeMode.click();
    await expect(writeMode).toBeChecked();
    const panel = page.getByTestId('write-mode-panel');
    await expect(panel, 'the Write Mode panel opens').toBeVisible();
    await expect(panel.locator('pre').first(), 'the panel shows the statement').toHaveText(STATEMENT);
    await expect(page.getByRole('button', { name: 'Run', exact: true }), 'Run is hidden in Write Mode').toHaveCount(0);
    const preview = panel.getByRole('button', { name: 'Preview' });
    const commit = panel.getByRole('button', { name: 'Commit' });
    await expect(preview, 'Preview waits for a description').toBeDisabled();
    await panel.getByRole('textbox', { name: 'Description' }).pressSequentially(description, { delay: 15 });
    await panel.getByRole('textbox', { name: 'Linear ticket' }).pressSequentially('ENG-1799', { delay: 40 });
    await expect(preview).toBeEnabled();
    await expect(commit, 'Commit waits for COMMIT to be typed').toBeDisabled();
    await beat(page);

    // Preview: run and rolled back.
    await preview.click();
    const result = panel.getByTestId('write-mode-result');
    await expect(result, 'the Preview returns a result').toBeVisible({ timeout: 60_000 });
    await expect(panel).not.toContainText('Write refused');
    await expect(panel).not.toContainText(QUERY_ERROR_TEXT);
    await expect(result.getByText('Rolled back', { exact: true }), 'the Preview was rolled back').toBeVisible();
    await expect(result, 'the Preview touched one row').toContainText('Rows affected: 1');
    const returning = result.getByTestId('write-mode-returning');
    await expect(returning.getByRole('cell', { name: 'demo-fill', exact: true }), 'the Preview returns the demo-fill row').toBeVisible();
    const previewTarget = Number(await returning.getByRole('cell').nth(1).innerText());
    expect(Number.isFinite(previewTarget), 'the Preview returns the new target').toBe(true);
    const previewAuditId = (await result.locator('code').innerText()).trim();
    expect(previewAuditId, 'the Preview has an audit id').not.toBe('');
    await returning.scrollIntoViewIfNeeded();
    await beat(page, 2_500);

    // Commit, confirmed by typing COMMIT.
    const confirm = panel.getByRole('textbox', { name: 'Type COMMIT to confirm' });
    await confirm.pressSequentially('commit', { delay: 60 });
    await expect(commit, 'only COMMIT exactly enables Commit').toBeDisabled();
    await confirm.fill('');
    await confirm.pressSequentially('COMMIT', { delay: 80 });
    await expect(commit, 'COMMIT typed exactly enables Commit').toBeEnabled();
    await beat(page);
    await commit.click();
    await expect(result.getByText('Committed', { exact: true }), 'the commit went through').toBeVisible({ timeout: 60_000 });
    await expect(panel).not.toContainText('Write refused');
    await expect(result).toContainText('Rows affected: 1');
    // Preview rolled back, so the commit returns the same new target.
    await expect(returning.getByRole('cell').nth(1), 'the commit returns the target the Preview showed').toHaveText(String(previewTarget));
    const commitAuditId = (await result.locator('code').innerText()).trim();
    expect(commitAuditId, 'the commit has its own audit record').not.toBe(previewAuditId);
    await expect(confirm, 'the typed confirmation is cleared after a commit').toHaveValue('');
    await returning.scrollIntoViewIfNeeded();
    await beat(page, 2_500);

    // The audit browser, filtered to the demo user: the commit and the Preview are the newest records.
    await page.getByRole('link', { name: 'Audit browser' }).click();
    await page.waitForURL(/\/audit$/);
    await expect(page.getByRole('heading', { name: 'Audit browser' })).toBeVisible();
    await page.getByRole('textbox', { name: 'User' }).pressSequentially(stack.demoUser.email, { delay: 20 });
    await page.getByRole('button', { name: 'Apply filters' }).click();
    const table = page.getByTestId('audit-executions');
    const ours = table.getByRole('row').filter({ hasText: description });
    await expect(ours, 'the audit browser lists the Preview and the commit').toHaveCount(2, { timeout: 30_000 });
    for (const row of await ours.all()) {
        await expect(row, 'each record is a write by the demo user').toContainText(stack.demoUser.email);
        await expect(row.getByText('write', { exact: true })).toBeVisible();
        await expect(row).toContainText('ENG-1799');
        await expect(row).toContainText('success');
    }
    // Newest first: the commit, then the Preview (marked "preview").
    await expect(ours.nth(0).getByText('preview', { exact: true }), 'the newest record is the commit').toHaveCount(0);
    await expect(ours.nth(1).getByText('preview', { exact: true }), 'the older record is the Preview').toBeVisible();

    await page.mouse.move(960, 1_060);
    await beat(page, 2_500);
    await scene.keyMoment(page);
    await beat(page);
});
