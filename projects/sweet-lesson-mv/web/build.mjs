// Assembles web/dist — the static site, with the same URL layout the dev server gives (/_src/…, /_vendor/…, /assets/…), nothing else.
//   node web/build.mjs            (run web/tools/build-assets.sh first: foley.m4a, tex-512)
// Serve it with: node web/serve.mjs 8750 --root web/dist --gzip     (gzip emulates a real static host's transfer sizes)
// The output is what Cloudflare Pages serves as is: index.html is the experience (walk.html, the same page, is kept), _headers carries the CSP and the cache rules.
// Nothing in dist is edited by hand: this script generates all of it. No deploy, no upload: this only copies files. refs/, data/, design/, out/ are read, never written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), project = path.resolve(here, ".."), repo = path.resolve(project, "../..");
const dist = path.join(here, "dist");
fs.rmSync(dist, { recursive: true, force: true });
const put = (src, dst) => { fs.mkdirSync(path.dirname(path.join(dist, dst)), { recursive: true }); fs.copyFileSync(src, path.join(dist, dst)); };
const tree = (srcDir, dstDir, filter = () => true) => { for (const f of fs.readdirSync(srcDir)) { const s = path.join(srcDir, f); if (fs.statSync(s).isDirectory()) tree(s, path.join(dstDir, f), filter); else if (filter(f)) put(s, path.join(dstDir, f)); } };
// the site
// the page: the QA-only inline loader (?glmem=1 → qa/glmem.js, which is not shipped) is removed — a CSP without 'unsafe-inline' for scripts must not meet an inline script
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lyrics = JSON.parse(fs.readFileSync(path.join(project, "data/lyrics.json"), "utf8"));
const sections = [0, 8.6, 38.3, 58.4, 91.1, 103.4, 132.7, 152.9, 176.3, Infinity];
const lyricHtml = sections.slice(0, -1).map((at, i) => `<div class="stanza">${lyrics.filter((l) => l.at >= at - 0.1 && l.at < sections[i + 1] - 0.1).map((l) => `<p>${escape(l.text)}</p>`).join("\n")}</div>`).join("\n");
const page = fs.readFileSync(path.join(here, "walk.html"), "utf8").replace(/<script>if \(\/\[\?&\]glmem=1\/[^\n]*<\/script>\n/, "");
const pageWithLyrics = page.replace(/<!-- site-lyrics -->[\s\S]*?<!-- \/site-lyrics -->/, `<!-- site-lyrics -->${lyricHtml}<!-- /site-lyrics -->`);
if (/<script>(?!<)/.test(pageWithLyrics)) throw new Error("walk.html still has an inline script");
for (const f of ["index.html", "walk.html"]) { fs.mkdirSync(dist, { recursive: true }); fs.writeFileSync(path.join(dist, f), pageWithLyrics); }
put(path.join(here, "page.css"), "page.css"); put(path.join(here, "fonts.css"), "fonts.css"); put(path.join(here, "favicon.svg"), "favicon.svg");
const only = (...ext) => (f) => !f.startsWith(".") && ext.some((e) => f.endsWith(e)); // dot-files (hook state, editors) and anything unexpected never ship
tree(path.join(here, "walk"), "walk", only(".js")); tree(path.join(here, "shim"), "shim", only(".js")); tree(path.join(here, "fonts"), "fonts", only(".woff2")); tree(path.join(here, "assets"), "assets", only(".m4a", ".jpg"));
// the MV's own files, read in place (what serve.mjs mounts at /_src/…)
put(path.join(project, "graphics/room.html"), "_src/room.html"); put(path.join(project, "timeline.json"), "_src/timeline.json"); put(path.join(project, "assets.json"), "_src/assets.json");
for (const f of ["camera", "credits", "grade", "inventory", "lyric_space", "lyrics"]) put(path.join(project, `data/${f}.json`), `_src/data/${f}.json`);
put(path.join(project, "design/room-fonts.css"), "_src/design/room-fonts.css"); tree(path.join(project, "design/fonts"), "_src/design/fonts", (f) => f.endsWith(".woff2"));
tree(path.join(project, "refs/tex"), "_src/refs/tex", (f) => f.endsWith(".jpg"));
put(path.join(project, "refs/Sweet Lesson.mp3"), "_src/refs/audio/Sweet Lesson.mp3");
for (const f of ["sweet-lesson.ja.srt", "sweet-lesson.en.srt"]) put(path.join(project, "out", f), `_src/out/${f}`);
put(path.join(repo, "src/runtime/three.js"), "_vendor/three.js");
// ---- _headers (Cloudflare Pages): the promise "not saved. not sent." is also kept by the browser — nothing may leave this origin
// script-src 'unsafe-eval': the ONE reason is shim/vos-shim.js, which runs the MV's own graphics/room.html script (fetched from this origin) with `new Function`. No other eval, no inline script, no external script.
// style-src 'unsafe-inline': room.html's <style> and its inline style="…" attributes are put in the page at runtime (and the UI sets its own <style>); styles can not run code.
// Cloudflare Web Analytics (allowed by the owner; per-page, no cookies): its beacon script (static.cloudflareinsights.com) and its report endpoint (cloudflareinsights.com) are the ONLY other origins; nothing the visitor writes goes anywhere.
// img-src / media-src 'self': the textures and the song are this origin's files; data:/blob: are NOT allowed (nothing needs them). connect-src 'self': fetch() of this site's json/srt only.
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-eval' https://static.cloudflareinsights.com", "style-src 'self' 'unsafe-inline'", "img-src 'self'", "media-src 'self'", "font-src 'self'", "connect-src 'self' https://cloudflareinsights.com", "worker-src 'none'", "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
const PERMISSIONS = "accelerometer=(), ambient-light-sensor=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), publickey-credentials-get=()";
const SHORT = "Cache-Control: public, max-age=300"; // files without a hash in their name: five minutes
const LONG = "Cache-Control: public, max-age=2592000"; // the song, the textures, the fonts, the foley: 30 days (change the file's name when changing the file)
// Pages MERGES the headers of every rule that matches (same name → joined), so Cache-Control is given in rules that do not overlap
const rules = [
  ["/*", [`Content-Security-Policy: ${CSP}`, "X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", `Permissions-Policy: ${PERMISSIONS}`, "Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Resource-Policy: same-origin", "X-Frame-Options: DENY"]],
  ["/", [SHORT]], ["/index.html", [SHORT]], ["/walk.html", [SHORT]], ["/page.css", [SHORT]], ["/fonts.css", [SHORT]], ["/favicon.svg", [SHORT]],
  ["/walk/*", [SHORT]], ["/shim/*", [SHORT]], ["/_vendor/*", [SHORT]],
  ["/_src/room.html", [SHORT]], ["/_src/timeline.json", [SHORT]], ["/_src/assets.json", [SHORT]], ["/_src/data/*", [SHORT]], ["/_src/design/room-fonts.css", [SHORT]], ["/_src/out/*", [SHORT]],
  ["/_src/design/fonts/*", [LONG]], ["/fonts/*", [LONG]], ["/_src/refs/*", [LONG]],
  ["/assets/*", [LONG]], ["/assets/foley.m4a", ["Content-Type: audio/mp4"]],
];
fs.writeFileSync(path.join(dist, "_headers"), "# generated by web/build.mjs — do not edit\n" + rules.map(([p, hs]) => `${p}\n${hs.map((h) => "  " + h).join("\n")}`).join("\n\n") + "\n");
// ---- what must NOT be in dist, and the size limit of Pages (25 MiB per file)
{
  const all = []; const w = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) w(p); else all.push(p); } }; w(dist);
  const bad = all.filter((p) => /(^|\/)(qa|review|\.claude|\.git|node_modules)(\/|$)|\.map$|(^|\/)\.[^/]+$|\.(md|mjs|py|sh)$/.test(path.relative(dist, p)) && !/(^|\/)_headers$/.test(p));
  const big = all.filter((p) => fs.statSync(p).size > 25 * 1048576);
  if (bad.length || big.length) throw new Error("dist is not clean: " + [...bad, ...big].map((p) => path.relative(dist, p)).join(", "));
  if (/sourceMappingURL/.test(fs.readFileSync(path.join(dist, "_vendor/three.js"), "utf8"))) throw new Error("three.js points at a source map");
  console.log("largest file:", all.map((p) => [fs.statSync(p).size, path.relative(dist, p)]).sort((a, b) => b[0] - a[0])[0].join(" "));
}
// report
let total = 0, n = 0; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else { total += fs.statSync(p).size; n++; } } }; walk(dist);
console.log(`web/dist: ${n} files, ${(total / 1048576).toFixed(1)} MB`);
