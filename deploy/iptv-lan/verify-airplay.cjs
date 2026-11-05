const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('/home/tangt4/serversetup/snowlite/node_modules/playwright');
const base = process.env.IPTV_WEB_URL || 'http://192.168.50.84:9191';
const channelNames = process.env.IPTV_AIRPLAY_CHANNELS ? process.env.IPTV_AIRPLAY_CHANNELS.split(',') : ['Hakka TV', 'ABC News'];
const config = Object.fromEntries(fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
const output = __dirname + '/evidence/airplay';
fs.mkdirSync(output, { recursive: true });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function waitForFrames(page, previous = null) {
  await page.waitForFunction(previous => {
    const v = document.querySelector('video');
    return v && (v.error || ((!previous || v.src !== previous) && v.videoWidth > 0 && v.currentTime > 0
      && (v.getVideoPlaybackQuality?.().totalVideoFrames || 0) > 0));
  }, previous, { timeout: 65000 });
  const mediaError = await page.locator('video').evaluate(v => v.error?.message);
  if (mediaError) throw new Error(mediaError);
  const before = await page.locator('video').evaluate(v => v.currentTime);
  await page.waitForTimeout(2200);
  const sample = await page.locator('video').evaluate(v => ({
    time: v.currentTime, width: v.videoWidth, height: v.videoHeight,
    frames: v.getVideoPlaybackQuality?.().totalVideoFrames,
    nativeHls: /\/proxy\/hls\/[\w-]+\/index\.m3u8$/.test(new URL(v.src).pathname),
  }));
  assert(sample.time > before, 'Playback did not advance');
  return sample;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const checks = { nativeHlsPlayback: [], simulatedPickerCalls: 0, sessionDeleteStatuses: [] };
  try {
    const context = await browser.newContext(phone);
    // Chromium has native HLS but no Apple device picker. Only that picker and
    // its status event are simulated; media URLs, loading and decoding are real.
    await context.addInitScript(() => {
      window.__airplayPickerCalls = 0;
      HTMLVideoElement.prototype.webkitShowPlaybackTargetPicker = function () {
        window.__airplayPickerCalls++;
        Object.defineProperty(this, 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, value: true });
        this.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
      };
    });
    const page = await context.newPage();
    let anonymousMediaRequests = 0;
    page.on('request', request => {
      if (/\/proxy\/hls\//.test(request.url()) && !request.headers().authorization) anonymousMediaRequests++;
    });
    page.on('response', response => {
      if (response.request().method() === 'DELETE' && /\/api\/proxy\/hls\/sessions\//.test(response.url())) {
        checks.sessionDeleteStatuses.push(response.status());
      }
    });
    await page.goto(base + '/channels', { waitUntil: 'networkidle' });
    await page.locator('input[name=username]').fill(config.DISPATCHARR_ADMIN_USERNAME);
    await page.locator('input[name=password]').fill(config.DISPATCHARR_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    try {
      await page.locator('.mobile-channel-card').first().waitFor();
    } catch {
      throw new Error('Channels did not initialize: ' + (await page.locator('body').innerText()).slice(-350));
    }
    const state = await context.storageState();
    let previous = null;
    for (const name of channelNames) {
      await page.getByRole('searchbox', { name: '搜索频道' }).fill(name);
      await page.getByRole('button', { name: `播放 ${name}`, exact: true }).click();
      const sample = await waitForFrames(page, previous);
      assert(sample.nativeHls, `${name} did not use a directly playable HLS URL`);
      previous = await page.locator('video').evaluate(v => v.src);
      const playlistResponse = await page.request.get(previous);
      const playlistText = await playlistResponse.text();
      assert(!playlistText.includes('#EXT-X-START:'), 'Native playback still overrides the player live start');
      const segment = playlistText.split('\n').find(line => line && !line.startsWith('#'));
      const segmentUrl = new URL(segment, previous).href;
      const range = await page.request.get(segmentUrl, { headers: { Range: 'bytes=0-187' } });
      assert.equal(range.status(), 206);
      assert.equal((await range.body()).length, 188);
      const head = await page.request.head(segmentUrl);
      assert.equal(head.status(), 200);
      assert(Number(head.headers()['content-length']) >= 188);
      checks.nativeManifestAndRangeResponses = true;
      checks.nativeHlsPlayback.push({ channel: name, ...sample });
      console.log(JSON.stringify({ channel: name, ...sample }));
      if (name === channelNames[0]) {
        const button = page.getByRole('button', { name: '投屏到 Apple TV' });
        await button.click();
        assert.equal(await button.getAttribute('aria-pressed'), 'true');
        assert.equal(await button.innerText(), '正在投屏');
        checks.simulatedPickerCalls = await page.evaluate(() => window.__airplayPickerCalls);
        for (const [width, height] of [[320, 740], [844, 390], [390, 844]]) {
          await page.setViewportSize({ width, height });
          const geometry = await page.locator('.dispatcharr-video-player').evaluate(el => {
            const b = el.getBoundingClientRect();
            const button = el.querySelector('.airplay-button').getBoundingClientRect();
            return { left: b.left, right: b.right, width: innerWidth, buttonHeight: button.height, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
          });
          assert(geometry.left >= 0 && geometry.right <= width + 1 && !geometry.overflow);
          assert(geometry.buttonHeight >= 44);
        }
        await page.screenshot({ path: output + '/phone-airplay.png' });
      }
    }
    await page.locator('.dispatcharr-video-player .mantine-CloseButton-root').click();
    await page.locator('.dispatcharr-video-player').waitFor({ state: 'detached' });
    await page.waitForTimeout(500);
    assert(checks.sessionDeleteStatuses.length >= channelNames.length && checks.sessionDeleteStatuses.every(status => status === 204));
    checks.anonymousNativeMediaRequests = anonymousMediaRequests;
    assert(anonymousMediaRequests > 0, 'TV-compatible URLs were not requested without browser credentials');

    const normal = await browser.newContext({ ...phone, storageState: state });
    const fallback = await normal.newPage();
    await fallback.goto(base + '/channels', { waitUntil: 'networkidle' });
    await fallback.getByRole('searchbox', { name: '搜索频道' }).fill('Hakka TV');
    await fallback.getByRole('button', { name: '播放 Hakka TV', exact: true }).click();
    checks.normalBrowserPlayback = await waitForFrames(fallback);
    assert.equal(await fallback.getByRole('button', { name: '投屏到 Apple TV' }).isDisabled(), true);
    await normal.close();
    await context.close();
    const result = { time: new Date().toISOString(), base, physicalAppleTvTested: false, checks };
    fs.writeFileSync(output + (base.includes(':19091') ? '/preview.json' : '/production.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
