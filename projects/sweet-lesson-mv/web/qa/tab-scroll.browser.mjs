import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.SWEET_TAB_URL||'http://127.0.0.1:8876';
const out=new URL(process.env.SWEET_TAB_LIVE?'../review/production-scroll/tab-final.json':'../review/snap/tab-results.json',import.meta.url);
const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-angle=metal']});const results=[];
const pass=n=>{results.push({name:n,status:'pass'});console.log('PASS',n);};
try {
 const p=await b.newPage({viewport:{width:1280,height:800}});await p.goto(base+'/?qa=1&tier=4&bench=0');await p.waitForFunction(()=>__walk.ready,null,{timeout:60000});
 assert.equal(await p.locator('#stage').getAttribute('tabindex'),'-1');await p.locator('nav a').last().focus();await p.keyboard.press('Tab');await p.waitForTimeout(700);assert.equal(await p.evaluate(()=>document.activeElement.id),'enter');pass('before entry Tab reaches Enter rather than inactive room');
 await p.locator('#mute').click();await p.locator('#enter').click();await p.waitForFunction(()=>!song.paused);assert.equal(await p.locator('#stage').getAttribute('tabindex'),'0');
 await p.locator('nav a').last().focus();await p.evaluate(()=>scrollTo(0,0));await p.waitForTimeout(700);await p.keyboard.press('Tab');await p.waitForTimeout(700);assert.equal(await p.evaluate(()=>document.activeElement.id),'stage');pass('Tab from header scrolls room into view and retains stage focus');
 await p.keyboard.down('w');await p.waitForFunction(()=>__walk.ctrl.in.fw===1);await p.keyboard.up('w');pass('keyboard walking works after Tab arrival');
 await p.mouse.move(600,300);await p.mouse.wheel(0,900);await p.waitForTimeout(700);assert.notEqual(await p.evaluate(()=>document.activeElement.id),'stage');await p.keyboard.down('w');assert.equal(await p.evaluate(()=>__walk.ctrl.in.fw),0);await p.keyboard.up('w');pass('intentional wheel releases stage and reading cannot walk');await p.close();
 const f=await b.newPage();await f.goto(base+'/?qa=1&nogl=1');await f.waitForFunction(()=>__walk.noRoom);assert.equal(await f.locator('#stage').getAttribute('tabindex'),'-1');pass('WebGL fallback excludes unavailable room from Tab sequence');await f.close();
} catch(e){results.push({status:'fail',message:e.stack});console.error(e);process.exitCode=1;}finally{await fs.writeFile(out,JSON.stringify({base,results},null,2));await b.close();}
