// MV-unchanged check at pixel level, independent of the video encoder: the real vos runtime page (compiled by `vos compile`) from the
// pre-web room.html (/tmp/slproj) and from the current one, each seeked frame by frame like `vos render` does; canvas pixels are hashed.
//   node web/qa/mvdiff.mjs [--times 10,30.5,...]
import { execFileSync } from "node:child_process";
const root = new URL("../../", import.meta.url).pathname;
const cdp = (...a) => execFileSync("node", ["web/tools/cdp.mjs", ...a], { encoding: "utf8", cwd: root, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = process.argv.indexOf("--times");
const times = (i > 0 ? process.argv[i + 1] : "10,30.5,60,92,100,132.9,133.5,134.2,134.4,134.6,134.9,135.8,190,197.5,200,205,208,212").split(",").map(Number);
const run = async (url) => {
  cdp("goto", url);
  for (let k = 0; k < 60; k++) { await sleep(500); if (cdp("eval", "typeof __timelines!=='undefined' && document.querySelector('canvas') ? 1 : 0") === "1") break; }
  await sleep(1500);
  return JSON.parse(cdp("eval", `(()=>{ const c=document.querySelector('canvas'), gl=c.getContext('webgl2'), w=c.width, h=c.height, px=new Uint8Array(w*h*4), out=[];
    for (const T0 of ${JSON.stringify(times)}) for (let j=0;j<24;j++){ const T=T0+j/24; __timelines.main.seek(T,false); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); let a=2166136261>>>0; for(let q=0;q<px.length;q+=1){ a^=px[q]; a=Math.imul(a,16777619)>>>0 } out.push([T,a]); }
    return JSON.stringify(out) })()`));
};
const A = await run("http://127.0.0.1:8731/_buildorig/index.html"), B = await run((process.env.B || "http://127.0.0.1:8731/_build/index.html"));
const bad = A.filter((a, k) => a[1] !== B[k][1]);
console.log(`frames ${A.length}  differing ${bad.length}`, bad.slice(0, 8).map((x) => x[0].toFixed(2)).join(" "));
if (!A.length || A.length !== B.length || bad.length) { console.error("MV DIFFERS (or nothing was compared)"); process.exit(1); }
