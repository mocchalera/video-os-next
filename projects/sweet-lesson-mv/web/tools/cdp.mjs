// Minimal CDP driver (Node ≥ 22, no deps) for the M0 measurements in a real, headed Chrome.
//   node web/tools/cdp.mjs launch [url]        start Chrome (separate profile in /tmp) with GPU, remote-debugging on :9333
//   node web/tools/cdp.mjs eval '<js>'         evaluate in the page (awaits promises), prints JSON
//   node web/tools/cdp.mjs shot <out.png>      screenshot of the page
//   node web/tools/cdp.mjs goto <url>
//   node web/tools/cdp.mjs click <x> <y>       real mouse click (user activation for audio)
//   node web/tools/cdp.mjs quit
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const PORT = 9333, CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [cmd, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
async function page() { const m = process.env.CDP_MATCH, t = (await targets()).find((x) => x.type === "page" && (!m || x.url.includes(m))); if (!t) throw new Error("no page"); return t; }
async function session() {
  const t = await page(); const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}
if (cmd === "launch") {
  const url = args[0] || "about:blank";
  const p = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/sl-chrome-profile", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900", "--window-position=40,40",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion", "--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", url], { detached: true, stdio: "ignore" });
  p.unref();
  for (let i = 0; i < 50; i++) { try { await targets(); break; } catch { await sleep(200); } }
  console.log(JSON.stringify({ ok: true, version: (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).Browser }));
} else if (cmd === "eval") {
  const s = await session();
  const r = await s.send("Runtime.evaluate", { expression: args[0], awaitPromise: true, returnByValue: true, timeout: 900000 });
  if (r.exceptionDetails) { console.error(JSON.stringify(r.exceptionDetails)); process.exitCode = 1; } else console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value));
  s.close();
} else if (cmd === "shot") {
  const s = await session(); const jpg = /\.jpe?g$/.test(args[0]); const r = await s.send("Page.captureScreenshot", jpg ? { format: "jpeg", quality: 92 } : { format: "png" }); fs.writeFileSync(args[0], Buffer.from(r.data, "base64")); console.log(args[0]); s.close();
} else if (cmd === "goto") {
  const s = await session(); await s.send("Page.navigate", { url: args[0] }); s.close();
} else if (cmd === "click") {
  const s = await session(); const [x, y] = args.map(Number);
  for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); s.close();
} else if (cmd === "drag") { // real mouse drag: drag x1 y1 x2 y2 [steps]
  const s = await session(); const [x1, y1, x2, y2, n = 12] = args.map(Number); const m = (type, x, y, buttons) => s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
  await m("mousePressed", x1, y1, 1); for (let i = 1; i <= n; i++) { await m("mouseMoved", x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 1); await new Promise((r) => setTimeout(r, 16)); } await m("mouseReleased", x2, y2, 0); s.close();
} else if (cmd === "key") { // real key event: key <Code> <down|up>   (Code like KeyW, ArrowUp)
  const s = await session(); const code = args[0], down = args[1] !== "up"; const ch = code.startsWith("Key") ? code.slice(3).toLowerCase() : code;
  const vk = code.startsWith("Key") ? code.charCodeAt(3) : { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32 }[code];
  await s.send("Input.dispatchKeyEvent", { type: down ? "rawKeyDown" : "keyUp", code, key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); s.close();
} else if (cmd === "emulate") { // emulate <w> <h> [dpr] [mobile=1]   |   emulate off
  const s = await session(); if (args[0] === "off") { await s.send("Emulation.clearDeviceMetricsOverride"); await s.send("Emulation.setTouchEmulationEnabled", { enabled: false }); } else { const [w, h, dpr = 3, mobile = 1] = args.map(Number); await s.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: !!mobile, screenOrientation: { type: h > w ? "portraitPrimary" : "landscapePrimary", angle: 0 } }); await s.send("Emulation.setTouchEmulationEnabled", { enabled: !!mobile, maxTouchPoints: 5 }); } s.close();
} else if (cmd === "media") { // media reduce | none   (prefers-reduced-motion)
  const s = await session(); await s.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: args[0] === "reduce" ? "reduce" : "no-preference" }] }); s.close();
} else if (cmd === "newtab") { // opens a second tab in front: the first one goes hidden
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(args[0] || "about:blank")}`, { method: "PUT" }); console.log((await r.json()).id);
} else if (cmd === "closetab") { await fetch(`http://127.0.0.1:${PORT}/json/close/${args[0]}`); await fetch(`http://127.0.0.1:${PORT}/json/activate/${(await targets()).find((x) => x.type === "page" && x.url.includes(process.env.CDP_MATCH || ""))?.id}`); 
} else if (cmd === "quit") {
  const s = await session(); await s.send("Browser.close").catch(() => {}); 
}
