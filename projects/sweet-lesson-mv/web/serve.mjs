// Sweet Lesson web — local dev server (zero deps). Serves web/ and mounts the MV project's files read-only,
// so graphics/room.html, data/*.json, design/*, refs/* are used in place (never copied).
// usage: node web/serve.mjs [port] [--gzip]        serves web/dist only (the built site: node web/build.mjs first) — what a phone on the tailnet should be shown
//        node web/serve.mjs [port] --qa            the dev tree (web/) plus the QA mounts (/_build, /_buildorig, …) and the MV project's files; for working on it, never for showing it
//        node web/serve.mjs [port] --root <dir>     only that directory
// (default port 8731, 127.0.0.1 only; HOST=<ip> to bind elsewhere)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const repo = path.resolve(project, "../..");
const argv = process.argv.slice(2), QA_MODE = argv.includes("--qa"), GZIP = argv.includes("--gzip"); // --root <dir>: serve only that built site (web/dist); --gzip: gzip text, as a real host would
let rootArg = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : null;
if (!rootArg && !QA_MODE) { rootArg = path.join(here, "dist"); if (!fs.existsSync(path.join(rootArg, "walk.html"))) { console.error("web/dist is not built: run  node web/build.mjs  (or start with --qa to serve the dev tree)"); process.exit(1); } }
const port = Number(argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8731);
const host = process.env.HOST || "127.0.0.1"; // HOST=<tailscale ip> for phone previews over the private tailnet only

// url prefix -> [directory or file, allowed? (read-only whitelist)]
const MOUNTS = [
  ["/_src/room.html", path.join(project, "graphics/room.html")],
  ["/_src/timeline.json", path.join(project, "timeline.json")],
  ["/_src/assets.json", path.join(project, "assets.json")],
  ["/_src/data/", path.join(project, "data/")],
  ["/_src/design/", path.join(project, "design/")],
  ["/_src/refs/tex/", path.join(project, "refs/tex/")],
  ["/_src/refs/audio/", path.join(project, "refs/")], // only Sweet Lesson.mp3 / sfx_stem.wav (checked below)
  ["/_src/out/", path.join(project, "out/")], // only *.srt (checked below)
  ["/_build/", path.join(project, ".vos/build/sweet-lesson/")], // QA only: the real vos runtime page, to compare the shim against
  ["/_buildorig/", "/tmp/slproj/.vos/build/sweet-lesson/"], // QA only (M2): the same page built from the pre-web room.html, to compare pixels
  ["/_buildvar/", "/tmp/slvar/.vos/build/sweet-lesson/"], // QA only
  ["/_vendor/three.js", path.join(repo, "src/runtime/three.js")],
  ["/", here + "/"],
];
if (rootArg) { MOUNTS.length = 0; MOUNTS.push(["/", path.resolve(process.cwd(), rootArg) + "/"]); }
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".woff2": "font/woff2", ".srt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
const AUDIO_OK = new Set(["Sweet Lesson.mp3", "sfx_stem.wav"]);

function resolve(url) {
  let p;
  try { p = decodeURIComponent(url.split("?")[0]); } catch { return { status: 400 }; } // a malformed %-escape is the client's mistake, not ours to die for
  if (p.includes("..") || p.includes("\0") || p.includes("\\")) return { status: 400 };
  for (const [prefix, target] of MOUNTS) {
    if (prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix) {
      const file = prefix.endsWith("/") ? path.join(target, p.slice(prefix.length)) : target;
      if (prefix === "/_src/refs/audio/" && !AUDIO_OK.has(path.basename(file))) return { status: 404 };
      if (prefix === "/_src/out/" && !file.endsWith(".srt")) return { status: 404 };
      if (prefix === "/" && p.startsWith("/_") && !rootArg) return { status: 404 };
      return { file, root: prefix.endsWith("/") ? target : null, qa: prefix.startsWith("/_build") };
    }
  }
  return { status: 404 };
}

// Cloudflare Pages' _headers, as far as the build writes it: a path pattern (* = anything), then indented "Name: value" lines. Every matching rule applies; the same header from two rules is joined with ", ".
const siteRules = (() => { try { const f = path.join(path.resolve(process.cwd(), rootArg || "."), "_headers"); if (!rootArg || !fs.existsSync(f)) return []; const out = []; let cur = null;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) { if (!line.trim() || line.startsWith("#")) continue; if (/^\s/.test(line)) { const m = /^\s+([^:]+):\s*(.*)$/.exec(line); if (m && cur) cur.headers.push([m[1].trim().toLowerCase(), m[2].trim()]); } else { cur = { re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), headers: [] }; out.push(cur); } } return out; } catch { return []; } })();
function siteHeaders(p) { const h = {}; for (const r of siteRules) if (r.re.test(p)) for (const [k, v] of r.headers) h[k] = k in h && k !== "content-type" ? h[k] + ", " + v : v; return h; }
const send = (res, status, body = "") => { if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain" }); res.end(body); };
http.createServer((req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405);
    const r = resolve(req.url);
    if (r.status) return send(res, r.status, r.status === 400 ? "bad request" : "not found");
    let file = r.file;
    let st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.isDirectory()) { file = path.join(file, "index.html"); st = fs.existsSync(file) ? fs.statSync(file) : null; }
    if (!st) return send(res, 404, "not found");
    // a file served from a project/web mount must really live under it (no symlink to somewhere else); the QA build mounts are symlink farms by design
    if (r.root && !r.qa) { const rf = fs.realpathSync(file), rr = fs.realpathSync(r.root); if (path.relative(rr, rf).startsWith("..")) return send(res, 404, "not found"); }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const head = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store", ...(rootArg ? siteHeaders(new URL(req.url, "http://x").pathname) : {}) }; // serving a built site: exactly the headers its _headers file gives (CSP included), as Cloudflare Pages would
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (GZIP && !range && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /^(text\/|application\/json|image\/svg)/.test(type)) { const buf = fs.readFileSync(file), z = zlib.gzipSync(buf, { level: 9 }); res.writeHead(200, { ...head, "content-encoding": "gzip", "content-length": z.length, vary: "accept-encoding" }); return void res.end(req.method === "HEAD" ? undefined : z); }
    const stream = (opts) => { const rs = fs.createReadStream(file, opts); rs.on("error", () => { res.destroy(); }); res.on("close", () => rs.destroy()); rs.pipe(res); };
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { "content-range": `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      if (req.method === "HEAD") return void res.end();
      stream({ start, end });
    } else {
      res.writeHead(200, { ...head, "content-length": st.size });
      if (req.method === "HEAD") return void res.end();
      stream();
    }
  } catch (e) { send(res, 500, "error"); } // whatever it was, it was one request
}).on("clientError", (e, sock) => { try { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} }).listen(port, host, () => console.log(`sweet-lesson web: http://${host}:${port}/walk.html`));
