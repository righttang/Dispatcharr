const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/home/tangt4/serversetup/snowlite/node_modules/playwright');

const base = process.env.IPTV_WEB_URL || 'http://127.0.0.1:19091';
const live = process.env.IPTV_LOGIN_LIVE === '1';
const config = Object.fromEntries(fs.readFileSync(__dirname + '/.env', 'utf8')
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
const username = config.DISPATCHARR_ADMIN_USERNAME;
const password = config.DISPATCHARR_ADMIN_PASSWORD;
const phone = {
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.8078.54 Mobile/15E148 Safari/604.1',
};

async function seedSavedPassword(context) {
  await context.addInitScript(({ username }) => {
    if (sessionStorage.getItem('login-test-seeded')) return;
    localStorage.setItem('dispatcharr_remembered_username', username);
    localStorage.setItem('dispatcharr_saved_password', btoa('previous-synthetic-password'));
    sessionStorage.setItem('login-test-seeded', '1');
  }, { username });
}

async function autofillAndSubmit(page) {
  await page.evaluate(({ username, password }) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const user = document.querySelector('input[name=username]');
    setter.call(user, username);
    setter.call(document.querySelector('input[name=password]'), password);
    user.form.requestSubmit();
  }, { username, password });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const checks = {};
  try {
    const context = await browser.newContext(phone);
    await seedSavedPassword(context);
    const page = await context.newPage();
    let status = 401;
    let submittedVisibleValues = false;
    let meRequests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/accounts/users/me/') meRequests++;
    });
    await context.route('**/api/accounts/token/', async route => {
      const data = route.request().postDataJSON();
      submittedVisibleValues = data.username === username && data.password === password;
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({
        detail: status === 401 ? 'No active account found with the given credentials' : 'Request was throttled.',
      }) });
    });
    await page.goto(base + '/channels', { waitUntil: 'networkidle' });
    await page.locator('input[name=password]').waitFor();
    await autofillAndSubmit(page);
    await page.getByRole('alert').filter({ hasText: '用户名或密码不正确' }).waitFor();
    assert(submittedVisibleValues, 'Form submitted stale saved values');
    assert.equal(meRequests, 0, 'Failed login still initialized protected data');
    assert.equal(await page.evaluate(() => localStorage.getItem('dispatcharr_saved_password')), null);
    checks.autofillUsesVisibleValues = true;
    checks.invalidCredentialsExplained = true;
    checks.failedLoginSkipsProtectedData = true;
    checks.rejectedSavedPasswordRemoved = true;
    status = 429;
    await page.getByRole('button', { name: 'Login', exact: true }).waitFor();
    await autofillAndSubmit(page);
    await page.getByRole('alert').filter({ hasText: '等待 1 分钟' }).waitFor();
    checks.rateLimitExplained = true;
    await context.close();

    if (live) {
      const real = await browser.newContext(phone);
      await seedSavedPassword(real);
      const actual = await real.newPage();
      await real.route('**/api/accounts/token/', async route => {
        const data = route.request().postDataJSON();
        if (data.username !== username || data.password !== password) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      await actual.goto(base + '/channels', { waitUntil: 'networkidle' });
      await actual.locator('input[name=password]').waitFor();
      await autofillAndSubmit(actual);
      await actual.locator('.mobile-channel-card').first().waitFor({ timeout: 30000 });
      checks.livePhoneLoginChannels = await actual.locator('.mobile-channel-card').count();
      await actual.reload({ waitUntil: 'networkidle' });
      await actual.locator('.mobile-channel-card').first().waitFor({ timeout: 30000 });
      checks.reloadedSession = true;
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: await real.storageState() });
      const desktopPage = await desktop.newPage();
      await desktopPage.goto(base + '/channels', { waitUntil: 'networkidle' });
      await desktopPage.locator('[aria-label="Preview channel"]').first().waitFor();
      checks.desktopSession = true;
      await desktop.close();
      await real.close();
    }
    const result = { time: new Date().toISOString(), base, checks };
    fs.mkdirSync(__dirname + '/evidence/login', { recursive: true });
    fs.writeFileSync(__dirname + `/evidence/login/${live ? 'production' : 'preview'}.json`, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
