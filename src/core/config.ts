import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonIf, which, writeJson } from "./util.ts";

/** Machine-local tool locations. Never committed. */
export interface MachineConfig {
  hyperframes_bin?: string;
  marlin_python?: string;
  marlin_model?: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONFIG_PATH = process.env.VOS_CONFIG ?? path.join(os.homedir(), ".config", "vos", "config.json");

export function loadConfig(): MachineConfig {
  return readJsonIf<MachineConfig>(CONFIG_PATH, {});
}

export function saveConfig(c: MachineConfig): void {
  writeJson(CONFIG_PATH, c);
}

export function hyperframesBin(): string | null {
  const c = loadConfig();
  const candidates = [process.env.VOS_HYPERFRAMES_BIN, c.hyperframes_bin, path.join(REPO_ROOT, "node_modules", ".bin", "hyperframes"), which("hyperframes") ?? undefined];
  for (const x of candidates) if (x && fs.existsSync(x)) return x;
  return null;
}

export function marlinPython(): string | null {
  const c = loadConfig();
  for (const x of [process.env.VOS_MARLIN_PYTHON, c.marlin_python]) if (x && fs.existsSync(x)) return x;
  return null;
}

export const MARLIN_WORKER = path.join(REPO_ROOT, "python", "marlin_worker.py");
export const REPO = REPO_ROOT;
