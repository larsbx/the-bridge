import { test, expect } from '@playwright/test';
import { password, sdkURL } from '../support/app.mjs';
const control = (request, path, data) => request.post('http://127.0.0.1:4174/__test/' + path, { data });
test.beforeEach(async ({ request }) => { await control(request, 'reset'); });
async function signIn(page) {
  await page.goto('/');
  await page.getByLabel('Dashboard passphrase').fill(password);
  await page.getByRole('button', { name: 'Unlock dashboard' }).click();
  await expect(page.locator('#finance')).toBeVisible();
}

test('native forms, filters, escaped HTML and logout work with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page);
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 123.45');
  await expect(page.locator('#finance img')).toHaveCount(0);
  await page.getByLabel('Merchant').fill('Fixture');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/q=Fixture/);
  await page.getByRole('button', { name: 'Check updates' }).click();
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 124.45');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Dashboard passphrase')).toBeVisible();
  await context.close();
});

test('only the small enhancement script loads; live updates preserve filters after reconnection', async ({ page, request }) => {
  const scripts = [];
  page.on('request', req => { if (req.resourceType() === 'script') scripts.push(req.url()); });
  await signIn(page);
  await page.getByLabel('Merchant').fill('Fixture');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('#status')).toContainText('connected');
  await control(request, 'change', { balance: 45678 });
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 456.78');
  await control(request, 'drop');
  await expect.poll(async () => (await (await control(request, 'state')).json()).streams).toBe(1);
  await control(request, 'change', { balance: 98765 });
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 987.65');
  await expect(page.getByLabel('Merchant')).toHaveValue('Fixture');
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every(url => url.endsWith('/bridge.js'))).toBe(true);
  await control(request, 'revoke');
  await expect(page.getByLabel('Dashboard passphrase')).toBeVisible();
});

test('Plaid SDK is lazy; successful linking exchanges once and update mode never exchanges', async ({ page, request }) => {
  let sdkRequests = 0;
  await page.route(sdkURL, async route => {
    sdkRequests++;
    await route.fulfill({ contentType: 'text/javascript', body: `window.Plaid = {create(options) { return {open() { options.onSuccess('public-sandbox-fixture', {institution: {name: 'Fixture bank'}}); }, destroy() {} }; }};` });
  });
  await signIn(page);
  expect(sdkRequests).toBe(0);
  await page.getByRole('button', { name: '+ Connect bank' }).click();
  await expect(page.locator('#status')).toContainText('Connection accepted');
  let state = await (await control(request, 'state')).json();
  expect(state.exchanges).toEqual([{ public_token: 'public-sandbox-fixture', institution: 'Fixture bank' }]);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await (await control(request, 'state')).json()).links.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  state = await (await control(request, 'state')).json();
  expect(state.links[1]).toEqual({ item_id: 'fixture-item' });
  expect(state.exchanges).toHaveLength(1);
  expect(sdkRequests).toBe(1);
});

test('Plaid SDK failure is retryable and does not leave the connect button disabled', async ({ page }) => {
  let attempts = 0;
  await page.route(sdkURL, async route => { attempts++; await route.abort(); });
  await signIn(page);
  const connect = page.getByRole('button', { name: '+ Connect bank' });
  await connect.click();
  await expect(page.locator('#status')).toContainText('Could not open');
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(connect).toBeEnabled();
});
