import { expect, test } from '@playwright/test';

const dashboardUrl = process.env.DASHBOARD_E2E_URL ?? 'http://127.0.0.1:4101/dashboard';
const mailpitUrl = process.env.MAILPIT_E2E_URL ?? 'http://127.0.0.1:4125';

test('public demo reaches the inbox, dashboard timeline, and Mailpit', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Good morning, Alex.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();

  await page.getByRole('button', { name: 'Send demo notification' }).click();
  await expect(page.getByText('Update sent. Open the inbox to see it arrive.')).toBeVisible();
  const bell = page.getByRole('button', { name: /Notifications, 1 unread/u });
  await expect(bell).toBeVisible({ timeout: 10_000 });
  await bell.click();
  await expect(page.getByText('Nina Kim completed “Finalize homepage copy”')).toBeVisible();
  await page.getByRole('button', { name: 'Mark Project update as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();

  const dashboard = await page.context().newPage();
  await dashboard.goto(dashboardUrl);
  const notificationRow = dashboard.getByRole('row').filter({ hasText: 'project.updated' }).first();
  await expect(notificationRow).toContainText('email · sent', { timeout: 15_000 });
  await expect(notificationRow).toContainText('sms · sent');
  await expect(notificationRow).toContainText('in-app · sent');
  await notificationRow.getByRole('button', { name: 'View details for project.updated' }).click();
  const dialog = dashboard.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'email' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'sms' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'in-app' })).toBeVisible();

  await expect
    .poll(async () => {
      const response = await request.get(`${mailpitUrl}/api/v1/messages`);
      return response.ok() ? JSON.stringify(await response.json()) : '';
    })
    .toContain('Project update: Website refresh');
});
