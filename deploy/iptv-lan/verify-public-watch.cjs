const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.IPTV_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.IPTV_WEB_URL || 'http://192.168.50.84:9191';
const output = __dirname + '/evidence/public-watch';
fs.mkdirSync(output, { recursive: true });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function selectChannel(page, name, native, previous = null) {
  console.log(JSON.stringify({ stage: 'playing', channel: name, native }));
  await page.getByRole('searchbox', { name: '搜索频道' }).fill(name);
  await page.getByRole('button', { name: `播放 ${name}`, exact: true }).click();
  await page.waitForFunction(previous => {
    const video = document.querySelector('video');
    const setupFailed = document.querySelector('.dispatcharr-video-player')?.textContent.includes('频道暂时未能加载');
    return video && (video.error || setupFailed || ((!previous || video.src !== previous)
      && video.videoWidth > 0 && video.currentTime > 0
      && (video.getVideoPlaybackQuality?.().totalVideoFrames || 0) > 0));
  }, previous, { timeout: 75000 });
  assert(!await page.locator('.dispatcharr-video-player').innerText().then(text => text.includes('频道暂时未能加载')), 'HLS server setup failed');
  assert.equal(await page.locator('video').evaluate(v => v.error?.message || null), null);
  const before = await page.locator('video').evaluate(v => v.currentTime);
  await page.waitForTimeout(2000);
  const sample = await page.locator('video').evaluate(v => ({
    time: v.currentTime, width: v.videoWidth, height: v.videoHeight,
    frames: v.getVideoPlaybackQuality?.().totalVideoFrames,
    nativeHls: new URL(v.src).pathname.startsWith('/proxy/hls/'),
  }));
  assert(sample.time > before);
  assert.equal(sample.nativeHls, native);
  return { channel: name, ...sample };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const result = { layouts: [], playback: [], anonymousSessionDeletes: [], physicalAppleTvTested: false };
  try {
    const context = await browser.newContext(phone);
    await context.addInitScript(() => localStorage.setItem('dispatcharr-player-prefs', JSON.stringify({ muted: true })));
    const page = await context.newPage();
    const managementRequests = [];
    const mediaAuth = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(channels|m3u|core|plugins|vod)\//.test(path)) managementRequests.push(path);
      if (path.startsWith('/proxy/')) mediaAuth.push(Boolean(request.headers().authorization));
    });
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.locator('.mobile-channel-card').first().waitFor();
    assert.equal(new URL(page.url()).pathname, '/channels');
    assert.equal(await page.locator('input[name=username]').count(), 0);
    assert(await page.getByRole('link', { name: '登录管理' }).isVisible());
    const catalogResponse = await page.request.get(base + '/api/watch/channels/');
    assert.equal(catalogResponse.status(), 200);
    const catalog = await catalogResponse.json();
    assert(catalog.enabled && catalog.channels.length > 0);
    for (const channel of catalog.channels) {
      assert.deepEqual(Object.keys(channel).sort(), ['channel_group_id', 'channel_number', 'id', 'name', 'native_output_profile_id', 'uuid']);
    }
    result.publicChannelCount = catalog.channels.length;
    result.playback.push(await selectChannel(page, 'Hakka TV', false));
    assert(await page.evaluate(() => !localStorage.getItem('accessToken') && !localStorage.getItem('refreshToken')));
    await page.locator('.dispatcharr-video-player .mantine-CloseButton-root').click();
    await page.getByRole('searchbox', { name: '搜索频道' }).fill('');
    for (const [width, height] of [[320, 740], [390, 844], [844, 390], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      assert(await page.getByRole('link', { name: '登录管理' }).isVisible());
      await page.screenshot({ path: `${output}/guest-${width}.png` });
      result.layouts.push({ width, height, overflow });
    }
    assert.deepEqual(managementRequests, []);
    assert(mediaAuth.length > 0 && mediaAuth.every(value => !value));
    result.guestUsesNoManagementEndpoints = true;
    result.guestMediaUsesNoJwt = true;
    console.log(JSON.stringify({ stage: 'guest', channels: result.publicChannelCount, playback: result.playback }));
    for (const [method, path] of [['GET', '/api/channels/channels/'], ['POST', '/api/channels/channels/'], ['PATCH', '/api/channels/channels/2147483647/'], ['DELETE', '/api/channels/channels/2147483647/']]) {
      const response = await context.request.fetch(base + path, { method, ...(method === 'POST' || method === 'PATCH' ? { data: {} } : {}) });
      assert([401, 403].includes(response.status()), `${method} ${path}: ${response.status()}`);
    }
    result.anonymousManagementDenied = true;
    await page.goto(base + '/manage/channels', { waitUntil: 'networkidle' });
    await page.locator('input[name=username]').waitFor();
    assert.equal(new URL(page.url()).pathname, '/login');
    await context.close();

    const native = await browser.newContext(phone);
    await native.addInitScript(() => {
      localStorage.setItem('dispatcharr-player-prefs', JSON.stringify({ muted: true }));
      HTMLVideoElement.prototype.webkitShowPlaybackTargetPicker = function () {
        window.__pickerCalls = (window.__pickerCalls || 0) + 1;
        Object.defineProperty(this, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, value: true });
        this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
      };
    });
    const nativePage = await native.newPage();
    let nativeAuthHeaders = 0;
    nativePage.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/proxy/') && request.headers().authorization) nativeAuthHeaders++;
    });
    nativePage.on('response', response => {
      if (response.request().method() === 'DELETE' && new URL(response.url()).pathname.startsWith('/api/watch/sessions/')) result.anonymousSessionDeletes.push(response.status());
    });
    await nativePage.goto(base + '/channels', { waitUntil: 'networkidle' });
    await nativePage.locator('.mobile-channel-card').first().waitFor();
    let previous = null;
    for (const name of ['Hakka TV', 'ABC News']) {
      result.playback.push(await selectChannel(nativePage, name, true, previous));
      previous = await nativePage.locator('video').evaluate(v => v.src);
    }
    await nativePage.getByRole('button', { name: '投屏到 Apple TV' }).click();
    assert.equal(await nativePage.evaluate(() => window.__pickerCalls), 1);
    await nativePage.locator('.dispatcharr-video-player .mantine-CloseButton-root').click();
    for (let i = 0; i < 50 && result.anonymousSessionDeletes.length < 2; i++) await nativePage.waitForTimeout(100);
    assert.deepEqual(result.anonymousSessionDeletes, [204, 204]);
    assert.equal(nativeAuthHeaders, 0);
    result.anonymousNativeHlsAndSimulatedPicker = true;
    await native.close();

    const expired = await browser.newContext(phone);
    let refreshAttempts = 0;
    await expired.addInitScript(() => {
      localStorage.setItem('refreshToken', 'expired-synthetic-refresh');
      localStorage.setItem('accessToken', 'expired-synthetic-access');
      localStorage.setItem('tokenExpiration', '1');
    });
    await expired.route('**/api/accounts/token/refresh/', route => {
      refreshAttempts++;
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Token expired"}' });
    });
    const expiredPage = await expired.newPage();
    await expiredPage.goto(base + '/channels', { waitUntil: 'networkidle' });
    await expiredPage.locator('.mobile-channel-card').first().waitFor();
    assert.equal(new URL(expiredPage.url()).pathname, '/channels');
    assert.equal(refreshAttempts, 1);
    result.expiredLoginFallsBackToGuest = true;
    await expired.close();

    const credentials = Object.fromEntries(fs.readFileSync(__dirname + '/.env', 'utf8').trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const admin = await browser.newContext(phone);
    const adminPage = await admin.newPage();
    await adminPage.goto(base + '/login?next=%2Fchannels', { waitUntil: 'networkidle' });
    await adminPage.locator('input[name=username]').fill(credentials.DISPATCHARR_ADMIN_USERNAME);
    await adminPage.locator('input[name=password]').fill(credentials.DISPATCHARR_ADMIN_PASSWORD);
    await adminPage.getByRole('button', { name: 'Login', exact: true }).click();
    await adminPage.getByRole('link', { name: '管理频道', exact: true }).waitFor();
    await adminPage.getByRole('link', { name: '管理频道', exact: true }).click();
    const edit = adminPage.getByRole('button', { name: 'Edit channel', exact: true }).first();
    await edit.waitFor({ timeout: 30000 });
    await edit.click();
    await adminPage.getByRole('dialog').waitFor();
    result.adminCanOpenChannelEditor = true;
    await admin.close();
    result.passed = true;
    fs.writeFileSync(output + '/production.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
