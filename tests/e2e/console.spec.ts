import { expect, test } from '@playwright/test';

test('console runs a query and shows streamed rows', async ({ page }) => {
  await page.goto('/console');
  await page.getByLabel('tenant').selectOption('tenant_a');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByTestId('counter')).toContainText('rows: 50000', { timeout: 30_000 });
  await expect(page.getByTestId('counter')).toContainText('done');
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('tenants page lists live tenant metrics', async ({ page }) => {
  await page.goto('/tenants');
  await expect(page.getByRole('heading', { name: /Live tenant metrics/ })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 });
});
