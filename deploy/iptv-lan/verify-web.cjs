// Run with the existing host Playwright installation and browser libraries.
const fs = require('fs');
const { chromium } = require('/home/tangt4/serversetup/snowlite/node_modules/playwright');
const root = __dirname;
const credentials = Object.fromEntries(fs.readFileSync(root + '/.env', 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://192.168.50.84:9191/', { waitUntil: 'networkidle' });
    await page.locator('input[name=username]').fill(credentials.DISPATCHARR_ADMIN_USERNAME);
    await page.locator('input[name=password]').fill(credentials.DISPATCHARR_ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL('**/channels');
    await page.locator('[aria-label="Preview channel"]').first().waitFor();
    await page.locator('select:has(option[value="500"])').first().selectOption('500');
    const name = process.argv[2] || 'Hakka TV';
    const position = await page.getByText(name, { exact: true }).first().evaluate(el => {
      let current = el;
      while (current && !current.querySelector('[aria-label="Preview channel"]')) current = current.parentElement;
      if (!current || current.querySelectorAll('[aria-label="Preview channel"]').length !== 1)
        throw new Error('Unique channel row not found');
      return Array.from(document.querySelectorAll('[aria-label="Preview channel"]'))
        .indexOf(current.querySelector('[aria-label="Preview channel"]'));
    });
    const started = Date.now();
    await page.locator('[aria-label="Preview channel"]').nth(position).click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      const frames = video?.getVideoPlaybackQuality?.().totalVideoFrames;
      return video && video.videoWidth > 0 && video.currentTime > 0 && !video.paused
        && video.readyState >= 2 && (frames === undefined || frames > 0);
    }, null, { timeout: 45000 });
    const firstFrameSeconds = (Date.now() - started) / 1000;
    const first = await page.locator('video').evaluate(v => ({
      time: v.currentTime, width: v.videoWidth, height: v.videoHeight, readyState: v.readyState,
      decodedFrames: v.getVideoPlaybackQuality?.().totalVideoFrames,
    }));
    await page.waitForTimeout(5000);
    const second = await page.locator('video').evaluate(v => ({
      time: v.currentTime, width: v.videoWidth, height: v.videoHeight, readyState: v.readyState,
      decodedFrames: v.getVideoPlaybackQuality?.().totalVideoFrames,
    }));
    if (second.time <= first.time) throw new Error('Playback did not advance');
    const result = { channel: name, firstFrameSeconds, first, second, errors, url: page.url() };
    fs.writeFileSync(root + '/evidence/web-playback.json', JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(root + '/evidence/web-playback-' + name.replace(/[^a-z0-9-]/gi, '_') + '.json',
      JSON.stringify(result, null, 2) + '\n');
    await page.screenshot({ path: root + '/evidence/web-playback.png' });
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
