import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";

const source = (name: string) => fs.readFileSync(new URL(`../src/runtime/${name}`, import.meta.url), "utf8");

// Exercise the bundled GSAP, not a seek stub: suppressEvents is the regression trigger.
function harness(proxied = false) {
  const roots = new Map<string, any>();
  const context = vm.createContext({
    window: { __VOS_CFG__: { duration: 8, fps: 30, width: 320, height: 180 } },
    document: { querySelector: (selector: string) => roots.get(selector) },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source("gsap.min.js"), context);
  context.gsap = context.window.gsap;
  if (proxied) {
    // Like HyperFrames' early timeline proxy: methods forward to real GSAP,
    // whereas assigning a method on the proxy doesn't change the real timeline.
    const create = context.gsap.timeline.bind(context.gsap);
    const unwrap = new Map<any, any>();
    context.gsap.timeline = (opts: any) => {
      const real = create(opts), proxy: any = {};
      unwrap.set(proxy, real);
      for (let proto = real; proto; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name === "constructor" || name.startsWith("_") || name in proxy) continue;
          const method = Object.getOwnPropertyDescriptor(proto, name)?.value;
          if (typeof method !== "function") continue;
          proxy[name] = (...args: any[]) => {
            if (name === "add") args[0] = unwrap.get(args[0]) ?? args[0];
            const result = method.apply(real, args);
            return result === real ? proxy : result;
          };
        }
      }
      return proxy;
    };
  }
  vm.runInContext(source("vos-runtime.js"), context);
  context.gsap.ticker.sleep();
  const vos = context.window.VOS;
  return {
    context, vos,
    mount(id: string, start: number, dur: number, fn: (ctx: any) => void) {
      const root = { visibility: "hidden" };
      roots.set(`section.vos-g[data-clip="${id}"]`, root);
      vos.mount({ id, start, dur }, fn);
      return root;
    },
    finalize() { vos.finalize(); context.gsap.ticker.sleep(); },
  };
}

test("onFrame follows suppressed seeks, including the HyperFrames two-seek adapter", () => {
  const h = harness(), times: number[] = [];
  h.mount("clock", 0, 8, ({ onFrame }) => onFrame((t: number) => times.push(t)));
  h.finalize();
  assert.deepEqual(times, [0]);
  for (const t of [0.8, 2, 3.3, 5.2, 0, 7.9]) {
    times.length = 0;
    h.vos.master.totalTime(t + 0.001, true);
    h.vos.master.totalTime(t, true);
    assert.equal(times.length, 2);
    assert.ok(Math.abs(times[0] - (t + 0.001)) < 1e-7);
    assert.equal(times[1], t);
  }
  h.vos.master.seek(4); // GSAP defaults to suppressEvents=true.
  assert.equal(times.at(-1), 4);
});

test("onFrame also follows seeks through a renderer timeline proxy", () => {
  const h = harness(true), times: number[] = [];
  h.mount("clock", 0, 8, ({ onFrame }) => onFrame((t: number) => times.push(t)));
  h.finalize();
  assert.deepEqual(times, [0]);
  times.length = 0;
  h.vos.master.totalTime(2.501, true);
  h.vos.master.totalTime(2.5, true);
  h.vos.master.seek(1, false);
  assert.deepEqual(times, [2.501, 2.5, 1]);
});

test("onFrame keeps clip-local time and start-inclusive/end-exclusive windowing", () => {
  const h = harness(), a: number[] = [], b: number[] = [];
  h.mount("a", 1, 2, ({ onFrame }) => onFrame((t: number) => a.push(t)));
  h.mount("b", 2, 3, ({ onFrame }) => onFrame((t: number) => b.push(t)));
  h.finalize();
  assert.deepEqual(a, []); assert.deepEqual(b, []);
  for (const t of [1, 2.5, 3, 5, 0, 2]) h.vos.master.totalTime(t, true);
  assert.deepEqual(a, [0, 1.5, 1]);
  assert.deepEqual(b, [0.5, 1, 0]);
});

test("onFrame sees child tween state after forward and backward renders", () => {
  const h = harness(), values: [number, number][] = [];
  const target = { value: 0 };
  h.mount("animated", 0, 8, ({ tl, onFrame }) => {
    tl.to(target, { value: 8, duration: 8, ease: "none" }, 0);
    onFrame((t: number) => values.push([t, target.value]));
  });
  h.finalize();
  values.length = 0;
  for (const t of [2, 6, 1, 0]) h.vos.master.totalTime(t, true);
  assert.deepEqual(values, [[2, 2], [6, 6], [1, 1], [0, 0]]);
});

test("non-suppressed seeks and playback renders run each handler once", () => {
  const h = harness(), times: number[] = [];
  h.mount("clock", 0, 8, ({ onFrame }) => onFrame((t: number) => times.push(t)));
  h.finalize();
  times.length = 0;
  h.vos.master.seek(1, false);
  h.vos.master.totalTime(2, false);
  // The GSAP root ticker calls timeline.render directly during playback.
  h.vos.master.render(3, false, false);
  assert.deepEqual(times, [1, 2, 3]);
});

test("the 3D helper updates and draws at clip-local time on suppressed seeks", () => {
  const h = harness(), calls: unknown[] = [];
  h.context.document.createElement = () => ({ style: {} });
  h.context.THREE = {
    WebGLRenderer: class {
      setPixelRatio() {} setSize() {}
      render() { calls.push("draw"); }
    },
    Scene: class {}, PerspectiveCamera: class {},
  };
  vm.runInContext(source("vos-three.js"), h.context);
  const root = h.mount("cube", 1, 3, ({ three }) => {
    const g = three({ el: { appendChild() {} } });
    g.update = (t: number) => calls.push(t);
  });
  h.finalize();
  h.vos.master.totalTime(2.5, true);
  assert.deepEqual(calls, [1.5, "draw"]);
  assert.equal(root.visibility, "visible");
  h.vos.master.totalTime(4, true);
  assert.deepEqual(calls, [1.5, "draw"]);
  assert.equal(root.visibility, "hidden");
});
