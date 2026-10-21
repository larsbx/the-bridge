import { test, expect } from '@playwright/test';
import { password, sdkURL } from '../support/app.mjs';
const control = (request, path, data) => request.post('http://127.0.0.1:4174/__test/' + path, { data });
test.beforeEach(async ({ request }) => { expect((await control(request, 'reset')).ok()).toBe(true); });
async function signIn(page) {
  await page.goto('/');
  await page.getByLabel('Dashboard passphrase').fill(password);
  await page.getByRole('button', { name: 'Unlock dashboard' }).click();
  await expect(page.locator('#finance')).toBeVisible();
}

test('production SvelteKit and real Ash/PostgreSQL authenticate, render and revoke without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.find(cookie => cookie.name === 'bridge_session');
  expect(session.value).toMatch(/^v1\./);
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 123.45');
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  expect(snapshot.accounts[0].current_cents).toBe('12345');
  await expect(page.locator('#finance img')).toHaveCount(0);
  await page.getByLabel('Merchant').fill('Fixture');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('Fixture purchase', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Dashboard passphrase')).toBeVisible();
  expect((await page.request.get('/api/snapshot')).status()).toBe(401);
  await context.close();
});

test('Plaid transport fixtures exercise real token encryption, reconciliation and authenticated SSE through Node', async ({ page, request }) => {
  await page.route(sdkURL, route => route.fulfill({ contentType: 'text/javascript', body: `window.Plaid = {create(options) { return {open() { options.onSuccess('public-sandbox-fixture', {institution: {name: 'Fixture bank'}}); }, destroy() {} }; }};` }));
  await signIn(page);
  await expect(page.locator('#status')).toContainText('connected');
  await page.getByRole('button', { name: '+ Connect bank' }).click();
  await expect(page.locator('#status')).toContainText('Connection accepted');
  await control(request, 'relink');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(async () => (await (await control(request, 'state')).json()).links.length).toBe(2);
  let state = await (await control(request, 'state')).json();
  expect(state.exchanges).toEqual([{ public_token: 'public-sandbox-fixture' }]);
  expect(state.links[1].access_token).toBe('access-sandbox-fixture');
  // This fake access token has passed through the real encrypted Item resource.
  const publicSnapshot = await (await page.request.get('/api/snapshot')).text();
  expect(publicSnapshot).not.toContain('access-sandbox-fixture');
  expect(publicSnapshot).not.toContain('encrypted_token');
  await control(request, 'change', { balance: 98765 });
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 987.65');
  await control(request, 'replace');
  await expect(page.getByRole('heading', { name: 'Replacement account' })).toBeVisible();
  await expect(page.locator('.kpi-value').first()).toHaveText('USD 987.65');
  await expect(page.locator('.historical')).toContainText('Historical');
  await expect(page.locator('.account-card')).toHaveCount(1);
  // A normal logout is also delivered to an already-open SSE stream.
  const csrf = await page.locator('meta[name="bridge-csrf"]').getAttribute('content');
  const response = await page.request.post('/logout', { headers: { origin: 'http://127.0.0.1:3173', 'x-csrf-token': csrf }, data: {}, maxRedirects: 0 });
  expect(response.status()).toBe(303);
  await expect(page.getByLabel('Dashboard passphrase')).toBeVisible();
});
