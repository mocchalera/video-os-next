// Small follow-up for focus and two-finger input; no playback endurance run.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal'] });
const results = []; const check = name => { results.push({ name, status: 'pass' }); console.log('PASS', name); };
const root = new URL('../review/scroll/', import.meta.url); await fs.mkdir(root, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, reducedMotion: 'reduce' }); const page = await context.newPage();
  await page.goto('http://127.0.0.1:8876/?qa=1&tier=4&bench=0'); await page.waitForFunction(() => __walk.ready, null, { timeout: 60000 });
  await page.screenshot({ path: new URL('page-top.png', root).pathname });
  await page.locator('#mute').click(); await page.locator('#enter').click(); await page.waitForFunction(() => !song.paused);
  await page.locator('#player a').click(); await page.locator('#room-mode').click(); await page.keyboard.down('w'); await page.waitForFunction(() => __walk.ctrl.in.fw === 1);
  await page.mouse.move(600, 250); await page.mouse.wheel(0, 750);
  await page.waitForFunction(() => __walk.ctrl.in.fw === 0 && document.activeElement.id !== 'stage');
  await page.keyboard.up('w'); await page.keyboard.down('w'); await page.waitForTimeout(100); assert.equal(await page.evaluate(() => __walk.ctrl.in.fw), 0); await page.keyboard.up('w'); check('scroll releases room focus and subsequent W cannot walk while reading');
  assert.equal(await page.evaluate(() => __walk.P.reduced), true); assert.equal(await page.locator('#hint').evaluate(e => getComputedStyle(e).transitionDuration), '0s'); check('reduced-motion controller and page transitions');
  await page.locator('#player a').click(); await page.locator('#room-mode').click(); await page.keyboard.press('q'); const focus = await page.locator('#stage').evaluate(e => ({ offset: getComputedStyle(e).outlineOffset, width: getComputedStyle(e).outlineWidth })); assert.equal(focus.offset, '-5px'); assert.equal(focus.width, '2px'); check('room keyboard focus outline stays inside clipped viewport');
  await context.close();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); const phone = await mobile.newPage();
  await phone.goto('http://127.0.0.1:8876/?qa=1&tier=4&bench=0'); await phone.waitForFunction(() => __walk.ready, null, { timeout: 60000 }); await phone.locator('#mute').tap(); await phone.locator('#enter').tap(); await phone.waitForFunction(() => !song.paused); await phone.locator('#player a').tap(); await phone.locator('#room-mode').tap();
  const cdp = await mobile.newCDPSession(phone); let pts = [{ x: 140, y: 350, id: 1 }, { x: 240, y: 350, id: 2 }]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts }); pts = pts.map(p => ({ ...p, y: 300 })); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts }); await phone.waitForFunction(() => __walk.ctrl.in.fw > .3); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await phone.waitForFunction(() => __walk.ctrl.in.fw === 0 && !__walk.ctrl.in.dragging); check('two-finger walk and touch cancel release');
  await phone.locator('#room-mode').tap(); assert.equal(await phone.locator('#stage').evaluate(e => getComputedStyle(e).touchAction), 'pan-y pinch-zoom'); await mobile.close();
} catch (e) { results.push({ name: 'input follow-up', status: 'fail', message: e.stack }); console.error(e); process.exitCode = 1; }
finally { await fs.writeFile(new URL('input-results.json', root), JSON.stringify({ executedAt: new Date().toISOString(), results }, null, 2)); await browser.close(); }
