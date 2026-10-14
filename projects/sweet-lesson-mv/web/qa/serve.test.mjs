// Server robustness (Sol M1 R2): a malformed request must be answered, not kill the process.
//   node web/qa/serve.test.mjs [port]     (starts its own server on a spare port, sends hostile requests, checks it still answers)
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
const port = Number(process.argv[2] || 18799);
const srv = spawn("node", ["web/serve.mjs", String(port), "--qa"], { cwd: new URL("../../", import.meta.url).pathname, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => new Promise((res) => { const s = net.connect(port, "127.0.0.1", () => { s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); }); let d = ""; s.on("data", (c) => (d += c)); s.on("close", () => res(d.split(" ")[1] || "closed")); s.on("error", () => res("error")); });
await sleep(700);
const cases = [["/%", "400"], ["/%zz", "400"], ["/%E0%A4%A", "400"], ["/walk.html", "200"], ["/_src/data/%2e%2e/timeline.json", "400"], ["/_src/refs/audio/Sweet%20Lesson.mp3", "200"], ["/..%5c..%5cetc", "400"], ["/_src/room.html", "200"], ["/nope", "404"]];
let bad = 0;
for (const [p, want] of cases) { const got = await get(p); const ok = got === want; if (!ok) bad++; console.log(`${ok ? "ok " : "BAD"} ${p} → ${got} (want ${want})`); }
const alive = await get("/walk.html"); if (alive !== "200") { bad++; console.log("BAD server no longer answers"); }
srv.kill(); console.log(bad ? `FAILED (${bad})` : "all ok"); process.exit(bad ? 1 : 0);
