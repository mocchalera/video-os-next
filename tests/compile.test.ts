import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, compileDigest } from "../src/compile/hyperframes.ts";
import { lintBuild } from "../src/render/render.ts";
import { loadProject } from "../src/core/project.ts";
import { exportFcp7 } from "../src/export/fcp7.ts";
import { fixtureProject, writeTimeline, baseTimeline } from "./helpers.ts";

const p = fixtureProject();
writeTimeline(p, baseTimeline());

test("same input → byte-identical page and digest", () => {
  const a = compile(loadProject(p.root));
  const b = compile(loadProject(p.root));
  assert.equal(a.htmlSha256, b.htmlSha256);
  assert.equal(compileDigest(a), compileDigest(b));
});

test("page follows HyperFrames media rules", () => {
  const { html, buildDir } = compile(loadProject(p.root));
  const videos = [...html.matchAll(/<video [^>]*>/g)].map((m) => m[0]);
  assert.equal(videos.length, 2);
  const idx = videos.map((v) => /data-track-index="(\d+)"/.exec(v)![1]);
  assert.equal(new Set(idx).size, idx.length, "unique track index per media element");
  for (const v of videos) assert.match(v, /id="m_/);
  assert.match(html, /<audio id="ma_music"[^>]*data-volume="0\.501/);
  assert.doesNotMatch(html, /<video[^>]*\.wav/, "audio clips never become video elements");
  // slot clip is inside the graphic section, not a timed wrapper
  const section = html.slice(html.indexOf('data-clip="title"'), html.indexOf("</section>"));
  assert.match(section, /id="m_w"/);
  assert.doesNotMatch(section.slice(0, section.indexOf("m_w")), /data-start/);
  // vos:// still was resolved to a file in the build
  assert.doesNotMatch(html, /vos:\/\//);
  const still = /media\/stills\/[^"]+\.jpg/.exec(html)![0];
  assert.ok(fs.existsSync(path.join(buildDir, still)));
});

test("receipt inputs record which assets were used and by what", () => {
  const c = compile(loadProject(p.root));
  assert.deepEqual(c.inputs.assets.clip.used_by.sort(), ["clip:a", "clip:w", "graphics/title.html@1.5"].sort());
  assert.ok(c.inputs.graphics["graphics/title.html"]);
});

test("props bind to artifacts; missing analysis fails with a hint", () => {
  const d: any = baseTimeline();
  d.tracks[1].clips[0].props = { d: { $describe: "clip" } };
  writeTimeline(p, d);
  assert.throws(() => compile(loadProject(p.root)), (e: any) => e.code === "missing_analysis" && /vos describe clip/.test(e.hint));
  d.tracks[1].clips[0].props = { a: { $asset: "clip" } };
  writeTimeline(p, d);
  assert.match(compile(loadProject(p.root)).html, /"filename":"clip\.mp4"/);
  writeTimeline(p, baseTimeline());
});

test("FCP7 export carries real source in/out in frames", () => {
  const c = compile(loadProject(p.root));
  const xml = exportFcp7(loadProject(p.root), { ...c.resolved, media: c.resolved.media.map((m) => ({ ...m, asset: { ...m.asset, path: m.asset.path } })) } as any);
  assert.match(xml, /<xmeml version="5">/);
  assert.match(xml, /<start>0<\/start><end>60<\/end><in>15<\/in><out>75<\/out>/); // clip a: in 0.5s
  assert.match(xml, /vos slot title\/win/);
  assert.match(xml, /<marker><name>B<\/name>/);
});

test("three.js is bundled only into pages whose graphics use it", () => {
  const p = fixtureProject();
  writeTimeline(p, baseTimeline());
  const plain = compile(loadProject(p.root));
  assert.ok(!fs.readFileSync(path.join(plain.buildDir, "index.html"), "utf8").includes('<script src="./three.js">'));
  assert.ok(!fs.existsSync(path.join(plain.buildDir, "three.js")));
  fs.writeFileSync(path.join(p.root, "graphics", "title.html"),
    `<div class="t" data-slot="win"></div><script>vos.graphic(({ three }) => { const g = three(); g.update = (t) => {}; });</script>`);
  const withThree = compile(loadProject(p.root));
  const html = fs.readFileSync(path.join(withThree.buildDir, "index.html"), "utf8");
  assert.match(html, /<script src="\.\/three\.js"><\/script>/);
  assert.ok(fs.statSync(path.join(withThree.buildDir, "three.js")).size > 1_000_000);
  assert.match(html, /"width":320,"height":180/, "the runtime knows the canvas size for the renderer");
});

test("the real HyperFrames lint passes a plain page and a 3D page (regression: the runtime once tripped missing_three_script)", () => {
  const p = fixtureProject();
  writeTimeline(p, baseTimeline());
  assert.deepEqual(lintBuild(compile(loadProject(p.root)).buildDir).errors, []);
  fs.writeFileSync(path.join(p.root, "graphics", "title.html"),
    `<div class="t" data-slot="win"></div><script>vos.graphic(({ three }) => { const g = three(); g.update = (t) => {}; });</script>`);
  assert.deepEqual(lintBuild(compile(loadProject(p.root)).buildDir).errors, []);
});
