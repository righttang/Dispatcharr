const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('/home/tangt4/serversetup/snowlite/node_modules/playwright');
const root = __dirname;
const base = 'http://192.168.50.84:9191';
const credentials = Object.fromEntries(fs.readFileSync(root + '/.env', 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let page = await context.newPage();
    await page.goto(base + '/login?next=%2Fchannels');
    await page.locator('input[name=username]').fill(credentials.DISPATCHARR_ADMIN_USERNAME);
    await page.locator('input[name=password]').fill(credentials.DISPATCHARR_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.locator('.mobile-channel-card').first().waitFor();
    for (const [index, name] of ['CCTV-5', '东方卫视', '湖南卫视'].entries()) {
      if (index) {
        page = await context.newPage();
        await page.goto(base + '/channels');
        await page.locator('.mobile-channel-card').first().waitFor();
      }
      await page.getByRole('searchbox', { name: '搜索频道' }).fill(name);
      const card = page.getByRole('button', { name: '播放 ' + name, exact: true });
      await card.waitFor();
      const started = Date.now();
      await card.click();
      await page.locator('video').waitFor();
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video?.videoWidth > 0 && video.readyState >= 2 && video.currentTime > 0
          && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0;
      }, null, { timeout: 60000 });
      const first = await page.locator('video').evaluate(video => ({
        time: video.currentTime, frames: video.getVideoPlaybackQuality?.().totalVideoFrames,
      }));
      const firstFrameSeconds = (Date.now() - started) / 1000;
      await page.waitForTimeout(name === '湖南卫视' ? 12000 : 3000);
      const video = await page.locator('video').evaluate(video => ({
        width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
        frames: video.getVideoPlaybackQuality?.().totalVideoFrames,
      }));
      assert(video.time > first.time && video.frames > first.frames, name + ' did not keep playing');
      if (name === '湖南卫视') assert(video.time - first.time >= 8, 'Hunan transcode cannot sustain playback');
      const entry = { name, firstFrameSeconds, video };
      results.push(entry);
      fs.writeFileSync(root + '/evidence/channel-diagnosis/core-playback.json', JSON.stringify({ base, results }, null, 2) + '\n');
      console.log(JSON.stringify(entry));
      await page.screenshot({ path: root + '/evidence/channel-diagnosis/playing-' + index + '.png' });
      await page.close();
    }
    fs.writeFileSync(root + '/evidence/channel-diagnosis/core-playback.json', JSON.stringify({ base, results }, null, 2) + '\n');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
