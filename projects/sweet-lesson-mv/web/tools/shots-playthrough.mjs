// One real-time playthrough (muted, no warm-up) from song time 0, taking a page screenshot when the audio clock passes each T.
// node web/tools/shots-playthrough.mjs <outdir> T1 T2 ...
import { execFileSync } from "node:child_process";
const [outdir, ...Ts] = process.argv.slice(2);
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: new URL("../../", import.meta.url).pathname }).trim();
cdp("goto", "http://127.0.0.1:8731/m0.html"); 
for (let i = 0; i < 60 && cdp("eval", "typeof __m0!=='undefined' && __m0.marks.readyFromNav ? 1 : 0") !== "1"; i++) await new Promise((r) => setTimeout(r, 300));
cdp("eval", "(async()=>{await __m0.start({t:0,muted:true});return 1})()");
const log = [];
for (const T of Ts.map(Number)) {
  while (Number(cdp("eval", "__m0.audio.currentTime")) < T) await new Promise((r) => setTimeout(r, 40));
  const name = `${outdir}/t${String(T).padStart(3, "0")}.jpg`; cdp("shot", name);
  log.push(`T=${T} shot at audio=${cdp("eval", "__m0.audio.currentTime")}`); console.log(log.at(-1));
}
cdp("eval", "__m0.stop()");
