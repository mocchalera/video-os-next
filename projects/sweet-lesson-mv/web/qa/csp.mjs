// The built site only (web/dist, served by the default serve.mjs with its _headers → the same CSP etc. as Cloudflare Pages): entrance → song → epilogue → again, desktop and phone, with the CSP enforced.
// Counts: CSP violations (securitypolicyviolation events + the console's "Refused to…"), failed / non-2xx requests, requests that left the origin, and which dist files were never requested.
//   node web/serve.mjs 8750 --gzip &   node web/qa/csp.mjs → web/review/m3/csp.json ; exit 1 on any violation
import fs from "node:fs";
import path from "node:path";
import { connect } from "../tools/cdpkit.mjs";
const here = new URL("../", import.meta.url).pathname, base = "http://127.0.0.1:8750"; const c = await connect("");
await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true }); await c.send("Log.enable"); await c.send("Runtime.enable");
await c.send("Page.enable");
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__csp=[]; document.addEventListener('securitypolicyviolation',e=>__csp.push([e.violatedDirective,e.blockedURI,e.sourceFile||'',e.lineNumber||0].join(' | ')));" });
const reqs = new Map(), urls = new Set(), problems = [], consoleV = []; let headers = null;
c.on("Network.requestWillBeSent", (p) => reqs.set(p.requestId, p.request.url));
c.on("Network.responseReceived", (p) => { const u = p.response.url; if (!u.startsWith(base)) return; urls.add(decodeURI(u.slice(base.length).split("?")[0])); if (p.response.status >= 400) problems.push(`${p.response.status} ${u}`); if (/\/(index\.html)?$/.test(u.split("?")[0]) && p.type === "Document") headers = p.response.headers; });
c.on("Network.loadingFailed", (p) => { if (p.errorText === "net::ERR_ABORTED" && !p.blockedReason) return; /* a media element or page that was left (again, navigation) */ problems.push(`failed ${reqs.get(p.requestId)} ${p.errorText} ${p.blockedReason || ""}`); });
c.on("Log.entryAdded", (p) => { if (/Content Security Policy|Refused to/i.test(p.entry.text || "")) consoleV.push(p.entry.text); });
c.on("Runtime.consoleAPICalled", (p) => { const t = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" "); if (/Content Security Policy|Refused to/i.test(t)) consoleV.push(t); });
const off = new Set(); c.on("Network.requestWillBeSent", (p) => { if (!p.request.url.startsWith(base) && !p.request.url.startsWith("data:") && !p.request.url.startsWith("blob:")) off.add(p.request.url); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = async () => { for (let i = 0; i < 200; i++) { try { if ((await c.eval("typeof __walk!=='undefined' && __walk.ready ? 1 : 0")) === 1) return; } catch { /* navigating */ } await sleep(300); } throw new Error("not ready"); };
const go = async (u) => { await c.send("Page.navigate", { url: u }); await sleep(900); };
const mouse = (type, x, y, buttons = 0) => c.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, pointerType: "mouse" });
const res = { flows: [] };

// ---- desktop: the front door is index.html
await c.emulate(1440, 900, 1, false); await go(`${base}/?qa=1&tier=3`); await ready();
const doc = await c.eval("JSON.stringify({title:document.title, lang:document.documentElement.lang, desc:document.querySelector('meta[name=description]').content, ogImage:document.querySelector('meta[property=\"og:image\"]').content, card:document.querySelector('meta[name=\"twitter:card\"]').content, scripts:[...document.scripts].map(s=>s.src||'INLINE')})");
res.document = JSON.parse(doc);
const eb = JSON.parse(await c.eval("JSON.stringify((()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})())"));
await mouse("mouseMoved", eb.x, eb.y); await mouse("mousePressed", eb.x, eb.y, 1); await mouse("mouseReleased", eb.x, eb.y); await sleep(7000);
const T1 = await c.eval("__walk.audio.currentTime"); res.flows.push({ step: "enter → the song plays (real, unmuted)", T: +T1.toFixed(2), ok: T1 > 3 });
await c.eval("__walk.seekTo(1e9)"); for (let i = 0; i < 40 && !(await c.eval("!!__walk.epi")); i++) await sleep(500); await sleep(6500);
await c.eval("__walk.stand({x:-0.1,y:1.45,z:-0.5,yaw:0,pitch:-0.1})"); await sleep(2000);
const wp = JSON.parse(await c.eval("JSON.stringify(__walk.epi.toClient({x:-0.55,y:1.2,z:-1.808}))"));
await mouse("mouseMoved", wp.x, wp.y); await mouse("mousePressed", wp.x, wp.y, 1); for (let i = 1; i <= 14; i++) { await mouse("mouseMoved", wp.x + i * 9, wp.y + Math.sin(i / 2) * 12, 1); await sleep(25); } await mouse("mouseReleased", wp.x + 126, wp.y); await sleep(400);
await c.eval("__walk.epi._autoOpen()"); await sleep(8500);
const again = JSON.parse(await c.eval("JSON.stringify((()=>{const r=document.querySelector('#cues .act[data-a=again]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})())"));
await c.eval("document.querySelector('#cues .act[data-a=log]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await sleep(500); const logOn = await c.eval("document.getElementById('log').classList.contains('on')"); await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 }); await c.send("Input.dispatchKeyEvent", { type: "keyUp", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 }); await sleep(300);
res.flows.push({ step: "epilogue: write, open the window, the log opens and closes", opened: await c.eval("__walk.epi.state === 'gone'"), logOpened: logOn });
const o0 = await c.eval("performance.timeOrigin"); const againBox = JSON.parse(await c.eval("JSON.stringify((()=>{const r=document.querySelector('#cues .act[data-a=again]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})())")); await mouse("mouseMoved", againBox.x, againBox.y); await mouse("mousePressed", againBox.x, againBox.y, 1); await mouse("mouseReleased", againBox.x, againBox.y); await sleep(1500); await ready();
res.flows.push({ step: "again → the entrance again", reloaded: (await c.eval("performance.timeOrigin")) !== o0 });
res.cspSeenInPage = await c.eval("JSON.stringify(__csp)");
// ---- phone (540 tier, 512² textures)
await c.emulate(390, 844, 3, true); await c.eval("try{sessionStorage.clear()}catch(e){}"); await go(`${base}/index.html?qa=1`); await ready();
const pb = JSON.parse(await c.eval("JSON.stringify((()=>{const r=document.getElementById('enter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}})())"));
await c.touch("touchStart", [{ x: pb.x, y: pb.y }]); await sleep(60); await c.touch("touchEnd", []); await sleep(6000);
res.flows.push({ step: "phone: enter → plays", tier: await c.eval("__walk.tier.name"), T: +(await c.eval("__walk.audio.currentTime")).toFixed(2) });
const pageV = JSON.parse(await c.eval("JSON.stringify(__csp)"));
// ---- desktop at the full 1080 tier: its textures (refs/tex 1024²) are requested too
await c.emulate(1440, 900, 1, false); await go(`${base}/walk.html?qa=1&tier=0`); await ready(); await sleep(1500);
pageV.push(...JSON.parse(await c.eval("JSON.stringify(__csp)")));
// ---- a sanity check that the CSP is really enforced here: one forbidden fetch MUST be blocked (and is not counted as a failure)
await c.eval("fetch('https://example.invalid/leak').catch(()=>{})"); await sleep(600); const sanity = JSON.parse(await c.eval("JSON.stringify(__csp)")); const blockedProbe = sanity.filter((v) => /example\.invalid/.test(v)).length;
const realViol = [...new Set([...JSON.parse(res.cspSeenInPage), ...pageV, ...consoleV])].filter((v) => !/example\.invalid/.test(v));
// ---- which files of dist were never requested (desktop + phone flows)
const all = []; const w = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) w(p); else all.push("/" + path.relative(path.join(here, "dist"), p)); } }; w(path.join(here, "dist"));
res.neverRequested = all.filter((f) => !urls.has(f) && f !== "/_headers" && f !== "/assets/og.jpg" /* only link-preview crawlers fetch it */ && !(f === "/index.html" && urls.has("/")) && f !== "/walk.html");
res.headers = headers && Object.fromEntries(["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "cache-control", "cross-origin-opener-policy"].map((k) => [k, headers[k] || headers[k.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())] || null]));
res.csp = { violations: realViol, enforcedProbeBlocked: blockedProbe > 0, requestsLeavingTheOrigin: [...off].filter((u) => !/example\.invalid/.test(u)), problems };
fs.writeFileSync(path.join(here, "review/m3/csp.json"), JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1)); c.close();
process.exit(realViol.length || !blockedProbe || res.csp.requestsLeavingTheOrigin.length || problems.length ? 1 : 0);
