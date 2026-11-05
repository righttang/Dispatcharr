const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('/home/tangt4/serversetup/snowlite/node_modules/playwright');
const root = __dirname;
const base = process.env.IPTV_WEB_URL || 'http://127.0.0.1:19091';
const credentials = Object.fromEntries(fs.readFileSync(root + '/.env', 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    const login = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const first = await login.newPage();
    await first.goto(base + '/login?next=%2Fchannels', { waitUntil: 'networkidle' });
    await first.locator('input[name=username]').fill(credentials.DISPATCHARR_ADMIN_USERNAME);
    await first.locator('input[name=password]').fill(credentials.DISPATCHARR_ADMIN_PASSWORD);
    await first.getByRole('button', { name: 'Login', exact: true }).click();
    await first.locator('.mobile-channel-card').first().waitFor();
    await first.screenshot({ path: root + '/evidence/mobile/after-portrait.png', fullPage: true });
    const initialCount = await first.locator('.mobile-channel-card').count();
    assert(initialCount > 0, 'No channels rendered');
    const manifestResponse = await first.request.get(base + '/static/channel-thumbnails/index.json');
    assert(manifestResponse.ok(), 'Thumbnail manifest not served');
    const manifest = await manifestResponse.json();
    assert(Object.keys(manifest.channels || {}).length > 0, 'No real channel snapshots captured');
    const firstSnapshot = first.locator('.mobile-channel-snapshot img').first();
    await firstSnapshot.waitFor();
    await firstSnapshot.scrollIntoViewIfNeeded();
    await first.waitForFunction(() => {
      const image = document.querySelector('.mobile-channel-snapshot img');
      return image?.complete && image.naturalWidth > 0;
    });
    const snapshot = await firstSnapshot.evaluate(img => ({
      width: img.naturalWidth, height: img.naturalHeight, lazy: img.loading,
      time: img.parentElement.querySelector('time')?.dateTime,
    }));
    assert(snapshot.width <= 480 && snapshot.width > 0 && snapshot.height > 0, 'Invalid snapshot dimensions');
    assert.equal(snapshot.lazy, 'lazy', 'Images should load on demand');
    assert(snapshot.time, 'Capture timestamp missing');
    results.push({ snapshots: { captured: Object.keys(manifest.channels).length, sample: snapshot } });
    await first.screenshot({ path: root + '/evidence/thumbnails/phone-snapshots.png' });
    await first.getByRole('searchbox', { name: '搜索频道' }).fill('CCTV13');
    assert.equal(await first.locator('.mobile-channel-card').count(), 1, 'Normalized search failed');
    assert.equal(await first.locator('.mobile-channel-card strong').innerText(), 'CCTV-13');
    await first.getByRole('button', { name: '清空搜索', exact: true }).click();
    assert.equal(await first.locator('.mobile-channel-card').count(), initialCount);
    await first.getByRole('button', { name: '澳洲频道', exact: true }).click();
    const groupNames = await first.locator('.mobile-channel-card strong').allTextContents();
    assert(groupNames.length > 0 && groupNames.every(name => name.startsWith('ABC')), 'Category filter failed');
    await first.getByRole('button', { name: '全部', exact: true }).click();
    await first.getByRole('button', { name: '打开菜单', exact: true }).click();
    await first.waitForFunction(() => Math.abs(document.querySelector('nav').getBoundingClientRect().x) < 1);
    assert.equal(Math.round((await first.locator('nav').boundingBox()).x), 0, 'Menu did not open');
    await first.getByRole('link', { name: /Channels/ }).click();
    await first.getByRole('button', { name: '打开菜单', exact: true }).waitFor();
    await first.waitForFunction(() => document.querySelector('nav').getBoundingClientRect().right <= 1);
    const state = await login.storageState();
    for (const [width, height] of [[390, 844], [320, 740], [844, 390]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, storageState: state });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/channels', { waitUntil: 'networkidle' });
      await page.locator('.mobile-channel-card').first().waitFor();
      const metrics = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.mobile-channel-card')];
        const bounds = cards.map(card => card.getBoundingClientRect());
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
          cards: cards.length, minCardHeight: Math.min(...bounds.map(r => r.height)),
          outsideCards: bounds.filter(r => r.left < 0 || r.right > innerWidth + 1).length,
          menuVisible: document.querySelector('nav')?.getBoundingClientRect().right > 0 };
      });
      assert(metrics.documentWidth <= width + 1, `Horizontal page overflow at ${width}`);
      assert.equal(metrics.outsideCards, 0, `Cards overflow at ${width}`);
      assert(metrics.minCardHeight >= 72, `Touch targets too small at ${width}`);
      assert.equal(metrics.menuVisible, false, 'Sidebar occupies phone screen');
      assert.equal(errors.length, 0, 'Uncaught page error');
      const screenshotImage = page.locator('.mobile-channel-snapshot img').first();
      await screenshotImage.scrollIntoViewIfNeeded();
      await screenshotImage.evaluate(img => img.decode());
      const cardMetrics = await screenshotImage.evaluate(img => {
        const card = img.closest('.mobile-channel-card');
        const image = img.getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        return { imageWidth: image.width, imageHeight: image.height, cardWidth: bounds.width,
          timeWidth: card.querySelector('time').getBoundingClientRect().width };
      });
      assert(cardMetrics.imageHeight > 0 && cardMetrics.imageWidth <= cardMetrics.cardWidth,
        `Thumbnail exceeds card at ${width}`);
      assert(cardMetrics.timeWidth <= cardMetrics.imageWidth, `Timestamp overflows at ${width}`);
      await page.screenshot({ path: root + `/evidence/thumbnails/phone-${width}x${height}.png` });
      await page.screenshot({ path: root + `/evidence/mobile/after-${width}x${height}.png` });
      results.push({ viewport: { width, height }, metrics, thumbnail: cardMetrics, errors });
      await context.close();
    }

    await first.getByRole('searchbox', { name: '搜索频道' }).fill('Hakka');
    await first.getByRole('button', { name: '播放 Hakka TV', exact: true }).click();
    await first.locator('video').waitFor();
    const player = await first.locator('.dispatcharr-video-player').boundingBox();
    assert(player.x >= 0 && player.x + player.width <= 391, 'Player exceeds phone viewport');
    await first.waitForFunction(() => {
      const video = document.querySelector('video');
      return video?.videoWidth > 0 && video.currentTime > 0 && video.readyState >= 2
        && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1) > 0;
    }, null, { timeout: 50000 });
    const t1 = await first.locator('video').evaluate(v => v.currentTime);
    await first.waitForTimeout(2500);
    const video = await first.locator('video').evaluate(v => ({
      time: v.currentTime, width: v.videoWidth, height: v.videoHeight,
      controls: v.controls, inline: v.playsInline,
    }));
    assert(video.time > t1, 'Video did not advance');
    assert(video.controls && video.inline, 'Phone video controls missing');
    await first.screenshot({ path: root + '/evidence/mobile/after-playing.png' });
    await first.setViewportSize({ width: 844, height: 390 });
    await first.waitForTimeout(500);
    const landscape = await first.locator('.dispatcharr-video-player').boundingBox();
    assert(landscape.x >= 0 && landscape.x + landscape.width <= 845);
    await first.screenshot({ path: root + '/evidence/mobile/after-playing-landscape.png' });
    results.push({ playback: video, playerPortrait: player, playerLandscape: landscape });
    await login.close();

    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: state });
    const desktopPage = await desktop.newPage();
    await desktopPage.goto(base + '/channels', { waitUntil: 'networkidle' });
    await desktopPage.locator('[aria-label="Preview channel"]').first().waitFor();
    assert.equal(await desktopPage.locator('.mobile-channel-card').count(), 0);
    await desktopPage.screenshot({ path: root + '/evidence/mobile/desktop.png' });
    results.push({ desktop: { channelActions: await desktopPage.locator('[aria-label="Preview channel"]').count() } });
    await desktop.close();
    fs.writeFileSync(root + '/evidence/mobile/verification.json', JSON.stringify({ base, results }, null, 2) + '\n');
    console.log(JSON.stringify({ base, channelCount: initialCount, checks: results }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
