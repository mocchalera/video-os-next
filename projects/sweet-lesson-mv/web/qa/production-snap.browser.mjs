// Native proximity snap: actual wheel/key/touch input, isolated low-resolution Chrome.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, args:['--use-angle=metal'] });
const out = new URL('../review/production-scroll/live-snap/', import.meta.url); await fs.mkdir(out,{recursive:true});
const results=[]; const pass=(name,details={})=>{results.push({name,status:'pass',...details});console.log('PASS',name,JSON.stringify(details));};
const settle=async p=>p.waitForTimeout(700);
const info=p=>p.evaluate(()=>{const r=document.getElementById('room-view').getBoundingClientRect(),b=document.getElementById('player').getBoundingClientRect();return {y:scrollY,target:r.top+scrollY,room:{top:r.top,bottom:r.bottom,height:r.height},bar:{top:b.top,height:b.height},height:innerHeight,snap:getComputedStyle(document.documentElement).scrollSnapType,classes:document.documentElement.className,paused:song.paused,time:song.currentTime,ended:song.ended,epi:__walk.getEpiState(),errors:__walk.errors};});
const fits=async p=>{const s=await info(p);assert(Math.abs(s.room.top)<1.1,JSON.stringify(s));assert(s.room.bottom<=s.bar.top+1,JSON.stringify(s));assert(Math.abs(s.room.bottom-s.bar.top)<2,JSON.stringify(s));return s;};
let page;
try{
 const ctx=await browser.newContext({viewport:{width:1280,height:800}});page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://sweet-lesson.mocchalera.app/?qa=1&tier=4&bench=0');await page.waitForFunction(()=>__walk.ready,null,{timeout:60000});await settle(page);
 assert.equal((await info(page)).y,0);assert.equal((await info(page)).snap,'none');pass('header remains at initial position, snapping waits for room approach');
 await page.evaluate(()=>{window.a0=song;window.cv0=stage.querySelector('canvas');window.c0=__walk.ctrl;window.seeks=[];song.addEventListener('seeking',()=>seeks.push(song.currentTime));});
 let s=await info(page);await page.mouse.move(600,200);await page.mouse.wheel(0,s.target-65);await settle(page);s=await fits(page);assert.match(s.snap,/^y(?: proximity)?$/);pass('approach from above settles to whole room above controls',s.room);
 await page.locator('#mute').click();await page.locator('#enter').click();await page.waitForFunction(()=>song.currentTime>.3&&!song.paused);
 const t0=await page.evaluate(()=>song.currentTime);
 await page.mouse.wheel(0,900);await settle(page);s=await info(page);assert(s.y>s.target+350,JSON.stringify(s));pass('deliberate downward wheel escapes into text');
 const y=s.y;await page.waitForTimeout(2000);assert(Math.abs((await info(page)).y-y)<2);pass('text position is not pulled back to room');
 await page.mouse.wheel(0,(s.target+70)-s.y);await settle(page);await fits(page);pass('approach from below settles to room');
 // Continued modest wheel gestures must also escape; no mandatory snap or snap-stop:always.
 await page.evaluate(()=>{window.snapLog=[];const take=(type)=>snapLog.push([type,Math.round(performance.now()),scrollY,document.getElementById('room-view').getBoundingClientRect().top,getComputedStyle(document.documentElement).scrollPaddingTop,document.documentElement.className]);addEventListener('wheel',e=>take('wheel:'+e.deltaY),{passive:true});addEventListener('scroll',()=>take('scroll'),{passive:true});new MutationObserver(()=>take('class')).observe(document.documentElement,{attributes:true,attributeFilter:['class']});});
 for(const dy of [130,130,130]){await page.mouse.wheel(0,dy);await page.waitForTimeout(100);}await settle(page);s=await info(page);assert(s.y>s.target+250,JSON.stringify(s));pass('continued modest wheel input escapes');
 // Inertia-shaped input toward the room finishes near its anchor.
 await page.evaluate(()=>scrollTo(0,0));await settle(page);
 for(const dy of [95,65,40,20,10,4]){await page.mouse.wheel(0,dy);await page.waitForTimeout(24);}await settle(page);await fits(page);pass('decelerating wheel burst settles without frame clipping');
 // Keyboard movement uses the same native scroll container.
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('PageDown');await settle(page);s=await info(page);assert(s.y>s.target+200,JSON.stringify(s));pass('PageDown escapes to text');
 await page.getByRole('link',{name:'歌詞',exact:true}).click();await settle(page);s=await info(page);assert(s.y>s.target+350);pass('lyrics anchor is not intercepted by room snap');
 await page.setViewportSize({width:900,height:700});await settle(page);s=await info(page);assert(s.y>s.target+250);pass('resize while reading does not reattach to room');
 await page.locator('#player a').click();await settle(page);await fits(page);pass('room-return anchor fits after window resize');
 await page.setViewportSize({width:780,height:520});await settle(page);await fits(page);pass('wrapped control bar is measured rather than covering room');
 await page.setViewportSize({width:1280,height:800});await settle(page);await fits(page);
 assert.equal(await page.evaluate(()=>a0===song&&cv0===stage.querySelector('canvas')&&c0===__walk.ctrl),true);assert.deepEqual(await page.evaluate(()=>seeks),[]);assert.equal(await page.evaluate(()=>song.paused),false);assert(await page.evaluate(()=>song.currentTime)>t0+5);pass('snap and resize retain audio, canvas, camera and playback, no seek');
 await page.screenshot({path:new URL('room-snapped.png',out).pathname});
 // Public audio may not be range-seekable; let the actual track finish without a seek.
 const accelerated=process.env.SWEET_ACCELERATE_END==='1';if(accelerated)await page.evaluate(()=>song.playbackRate=16);const endStarted=Date.now();console.log('WAIT public audio end',await page.evaluate(()=>({time:song.currentTime,duration:song.duration,seekable:Array.from({length:song.seekable.length},(_,i)=>[song.seekable.start(i),song.seekable.end(i)])})));await page.waitForFunction(()=>song.ended&&__walk.getEpiState()!==null,null,{timeout:245000});await settle(page);await fits(page);
 await page.locator('#room-mode').click();await page.keyboard.down('w');await page.waitForFunction(()=>__walk.ctrl.in.fw===1);await page.keyboard.up('w');await page.keyboard.press('Escape');pass('natural ended transition keeps snapped room and epilogue exploration',{waitMs:Date.now()-endStarted,time:await page.evaluate(()=>song.currentTime),duration:await page.evaluate(()=>song.duration),mode:accelerated?'accelerated playback without seeking':'full natural playback without seeking'});
 assert.deepEqual(errors,[]);assert.deepEqual((await info(page)).errors,[]);pass('no runtime errors');await ctx.close();
 const reduced=await browser.newContext({viewport:{width:1100,height:700},reducedMotion:'reduce'});const rp=await reduced.newPage();await rp.goto('https://sweet-lesson.mocchalera.app/?qa=1&nogl=1');await rp.waitForFunction(()=>__walk.noRoom);assert.equal((await info(rp)).snap,'none');await rp.locator('#player a').click();await settle(rp);await fits(rp);pass('reduced motion disables snap; explicit room link still fits');await reduced.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true});const mp=await mobile.newPage();await mp.goto('https://sweet-lesson.mocchalera.app/?qa=1&tier=4&bench=0');await mp.waitForFunction(()=>__walk.ready,null,{timeout:60000});await mp.locator('#player a').tap();await settle(mp);await fits(mp);pass('mobile portrait room fits above actual control bar');
 await mp.locator('#mute').tap();await mp.locator('#enter').tap();await mp.waitForFunction(()=>!song.paused);await mp.locator('#room-mode').tap();await settle(mp);await fits(mp);pass('long interaction-mode label can wrap without hiding room');await mp.locator('#room-mode').tap();
 const cd=await mobile.newCDPSession(mp);await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:580,id:1}]});for(const y of [480,370,250,120]){await cd.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y,id:1}]});await mp.waitForTimeout(35);}await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(mp);s=await info(mp);assert(s.y>s.target+250,JSON.stringify(s));pass('mobile deliberate vertical swipe escapes room');
 await mp.setViewportSize({width:390,height:700});await settle(mp);s=await info(mp);assert(s.y>s.target+250);pass('mobile viewport height change while reading does not reattach');await mp.locator('#player a').tap();await settle(mp);await fits(mp);pass('mobile dynamic-height equivalent fits visible viewport');
 await mp.setViewportSize({width:844,height:390});await settle(mp);await fits(mp);assert.equal(await mp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);pass('landscape resize fits room and wrapped controls without overflow');await mp.screenshot({path:new URL('mobile-landscape.png',out).pathname});await mobile.close();
}catch(e){results.push({name:'snap regression',status:'fail',message:e.stack});console.error(e);if(page)console.log('SNAPLOG',JSON.stringify(await page.evaluate(()=>window.snapLog||[]).catch(()=>[])).slice(-12000));if(page)await page.screenshot({path:new URL('failure.png',out).pathname}).catch(()=>{});process.exitCode=1;}
finally{await fs.writeFile(new URL('results.json',out),JSON.stringify({executedAt:new Date().toISOString(),browser:'isolated installed Chrome / Metal / tier 4',results},null,2));await browser.close();}
