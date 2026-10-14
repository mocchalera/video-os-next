// A persistent CDP session (device emulation lives only as long as the session does): connect() → { send, eval, shot, goto, key, tap, touch, close }.
import fs from "node:fs";
const PORT = 9333;
export async function connect(match = "") {
  const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === "page" && x.url.includes(match)); if (!t) throw new Error("no page");
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const subs = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method && subs.has(d.method)) for (const f of subs.get(d.method)) f(d.params); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = {
    send, sleep,
    on(method, fn) { if (!subs.has(method)) subs.set(method, []); subs.get(method).push(fn); },
    async eval(expr) { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails)); return r.result.value; },
    async shot(path) { const jpg = /\.jpe?g$/.test(path); const r = await send("Page.captureScreenshot", jpg ? { format: "jpeg", quality: 90 } : { format: "png" }); fs.writeFileSync(path, Buffer.from(r.data, "base64")); },
    async goto(url) { if (/\/walk\.html/.test(url) && !/[?&]qa=/.test(url)) url += (url.includes("?") ? "&" : "?") + "qa=1"; await send("Page.navigate", { url }); await sleep(600); /* let the old document go, or waitReady() sees it */ },
    async waitReady() { for (let i = 0; i < 200; i++) { try { if ((await api.eval("typeof __walk!=='undefined' && __walk.ready ? 1 : 0")) === 1) return; } catch { /* navigating */ } await sleep(300); } throw new Error("not ready"); },
    async emulate(w, h, dpr = 3, mobile = true) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile, screenOrientation: { type: h > w ? "portraitPrimary" : "landscapePrimary", angle: h > w ? 0 : 90 } }); await send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }); },
    async media(reduce) { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }); },
    async touch(type, pts) { await send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1 })) }); },
    async tap(x, y) { await api.touch("touchStart", [{ x, y }]); await sleep(40); await api.touch("touchEnd", []); },
    async key(code, down = true) { const ch = code.startsWith("Key") ? code.slice(3).toLowerCase() : code; const vk = code.startsWith("Key") ? code.charCodeAt(3) : { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, Enter: 13, BracketLeft: 219, BracketRight: 221 }[code]; const text = code === "Enter" ? "\r" : code === "Space" ? " " : undefined; /* Enter / Space on a focused button need the character event to click it */ await send("Input.dispatchKeyEvent", { type: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp", code, key: code === "Space" ? " " : ch, text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); },
    close() { ws.close(); },
  };
  return api;
}
