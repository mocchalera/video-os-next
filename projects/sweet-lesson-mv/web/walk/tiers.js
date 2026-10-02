// Quality tiers: an internal resolution (the whole post chain runs at it) plus the three memory knobs room.html reads (window.__roomWebQ).
// The numbers come from qa/glmem.js (what is allocated, by what) and qa/tiers.mjs (what each tier costs): see m3-report.md.
export const TIERS = [
  { id: 0, name: "1080", res: 1080, q: { msaa: 4, shadow: 1, dc: 1 }, tex: 1024 },    // the MV's own: every knob as vos renders it
  { id: 1, name: "900", res: 900, q: { msaa: 4, shadow: 1, dc: 1 }, tex: 1024 },
  { id: 2, name: "720", res: 720, q: { msaa: 2, shadow: 0.5, dc: 0.5 }, tex: 512 },
  { id: 3, name: "540", res: 540, q: { msaa: 0, shadow: 0.5, dc: 0.5 }, tex: 512 },   // phones
  { id: 4, name: "432", res: 432, q: { msaa: 0, shadow: 0.25, dc: 0.5 }, tex: 512 },  // the floor (432 = 768×432: the post chain halves and quarters its targets, so the height must divide by 8 — 405 renders black)
];
const phone = () => /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/** which tier to start with: ?tier=N wins; then what an earlier run in this tab decided; then the device (a phone → 540, little memory/few cores → lower, else the MV's own) */
export function pickTier(params = new URLSearchParams(location.search)) {
  const forced = params.get("tier"); if (forced !== null && TIERS[Number(forced)]) return { tier: TIERS[Number(forced)], why: "?tier=" };
  // the automatic step-down: what an earlier run in this tab saved, or ?autotier= (what the page itself put in the URL when storage was not available); the lower of the two wins. Neither is a manual fix: the benchmark still runs.
  let saved = null; try { saved = sessionStorage.getItem("sl-tier"); } catch { /* private mode */ }
  const auto = params.get("autotier"), lvl = Math.max(saved !== null ? Number(saved) : -1, auto !== null ? Number(auto) : -1);
  if (lvl >= 0 && TIERS[lvl]) return { tier: TIERS[lvl], why: "an earlier run in this tab was too slow" };
  const mem = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 4;
  if (phone()) return { tier: TIERS[3], why: "a phone" };
  if (mem <= 4) return { tier: TIERS[3], why: `deviceMemory ${mem} GB` };
  if (cores <= 4) return { tier: TIERS[2], why: `${cores} cores` };
  return { tier: TIERS[0], why: "desktop" };
}
// typical GPU time at the heavy moments per tier on the machines measured (qa/tiers.mjs: 17.4 / 16.9 / 12.1 / 10.3 / 9.3 ms): used to jump straight to a tier that should pass instead of failing one step at a time (each failure is a reload)
const REL = [17.4, 16.9, 12.1, 10.3, 9.3];
export function tierFor(id, worstMs, budgetMs = 14.5) { let n = id + 1; while (n < TIERS.length - 1 && worstMs * (REL[n] / REL[id]) > budgetMs) n++; return Math.min(TIERS.length - 1, n); }
export function stepDown(id, to) { const n = Math.min(TIERS.length - 1, to ?? id + 1); try { sessionStorage.setItem("sl-tier", String(n)); } catch { /* ignore */ } return n; }
