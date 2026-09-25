import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonIf, which, writeJson } from "./util.ts";

/** Machine-local tool locations. Never committed. */
export interface MachineConfig {
  hyperframes_bin?: string;
  python?: string; // one interpreter for every model worker (Marlin, embeddings)
  marlin_python?: string; // legacy key, still honoured
  marlin_model?: string;
  asr_python?: string; // interpreter with faster-whisper for `vos transcribe`
  gen_library?: string; // shared folder for generated clips (e.g. inside Google Drive for desktop)
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
  // repo-owned install wins; env / machine config are explicit overrides
  const repo = path.join(REPO_ROOT, "node_modules", ".bin", "hyperframes");
  const candidates = [process.env.VOS_HYPERFRAMES_BIN, fs.existsSync(repo) ? repo : undefined, c.hyperframes_bin, which("hyperframes") ?? undefined];
  for (const x of candidates) if (x && fs.existsSync(x)) return x;
  return null;
}

/** Repo-owned environment first; machine config / env only override it. */
export const REPO_PYTHON = path.join(REPO_ROOT, "python", ".venv", "bin", "python3");

export function pythonBin(): string | null {
  const c = loadConfig();
  for (const x of [process.env.VOS_PYTHON, process.env.VOS_MARLIN_PYTHON, c.python, REPO_PYTHON, c.marlin_python]) if (x && fs.existsSync(x)) return x;
  return null;
}

export const marlinPython = pythonBin;

export const MARLIN_WORKER = path.join(REPO_ROOT, "python", "marlin_worker.py");
export const REPO = REPO_ROOT;
