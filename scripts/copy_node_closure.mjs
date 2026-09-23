// Copy a package and its full runtime dependency closure from an existing install,
// resolving exactly like Node does (walk up node_modules from each dependent).
//   node copy_node_closure.mjs <src-root> <dst-root> <package>
import fs from "node:fs";
import path from "node:path";
const [src, dst, pkg] = process.argv.slice(2).map((x, i) => (i < 2 ? path.resolve(x) : x));
const seen = new Set();
function resolveDir(fromDir, name) {
  let d = fromDir;
  for (;;) {
    if (path.basename(d) !== "node_modules") {
      const cand = path.join(d, "node_modules", name);
      if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    }
    if (d === src || d === path.dirname(d)) return null;
    d = path.dirname(d);
  }
}
const missing = [];
function visit(dir) {
  const real = fs.realpathSync(dir);
  if (seen.has(real)) return;
  seen.add(real);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const rel = path.relative(src, dir);
  const out = path.join(dst, rel);
  if (!fs.existsSync(out)) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.cpSync(dir, out, { recursive: true, verbatimSymlinks: true }); }
  const deps = { ...(pj.dependencies ?? {}), ...(pj.optionalDependencies ?? {}), ...(pj.peerDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    const d = resolveDir(dir, name);
    if (d) visit(d);
    else if (!(pj.optionalDependencies ?? {})[name] && !(pj.peerDependenciesMeta ?? {})[name]?.optional) missing.push(`${pj.name} → ${name}`);
  }
}
visit(path.join(src, "node_modules", pkg));
console.log(`copied ${seen.size} packages`);
if (missing.length) console.log("unresolved (non-optional):\n  " + missing.join("\n  "));
