/**
 * verify-paths — ground proposed file paths against the real repo universe.
 *
 * File-path hallucination is the #1 coding-agent failure and is uncorrelated with
 * coding skill, so it cannot be prompted away — it must be checked. The pure core
 * here takes a list of proposed paths and the known universe (from `git ls-files`)
 * and returns which are real and, for the rest, the closest real candidates so the
 * model can correct itself instead of inventing.
 */

import { basename } from "node:path";

export interface GroundResult {
  real: string[];
  missing: { path: string; suggestions: string[] }[];
}

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|md|json|sh|yml|yaml|toml|txt|css|html)$/i;

/** Backticked tokens that look like file paths (have a slash or a known extension); :line/range stripped. */
export function extractCitedPaths(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^`]+)`/g)) {
    const raw = m[1].trim();
    const path = raw.replace(/:\d+(?:[-–—]\d+)?$/, ""); // strip :line or :line-range (ascii/en/em dash)
    if (/\s/.test(path)) continue;
    if (path.includes("/") || PATH_EXT_RE.test(path)) out.add(path);
  }
  return [...out];
}

function stemKey(file: string): string {
  return basename(file)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isReal(path: string, universe: string[]): boolean {
  if (universe.includes(path)) return true;
  const asDir = `${path}/`;
  return universe.some((f) => f.startsWith(asDir));
}

function suggestionsFor(path: string, universe: string[]): string[] {
  const key = stemKey(path);
  const exactStem = universe.filter((f) => stemKey(f) === key);
  if (exactStem.length > 0) return exactStem.slice(0, 5);
  const stem = basename(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  if (!stem) return [];
  return universe.filter((f) => basename(f).toLowerCase().includes(stem)).slice(0, 5);
}

export function groundPaths(proposed: string[], universe: string[]): GroundResult {
  const real: string[] = [];
  const missing: { path: string; suggestions: string[] }[] = [];
  for (const raw of proposed) {
    const p = normalizePath(raw);
    if (isReal(p, universe)) real.push(p);
    else missing.push({ path: p, suggestions: suggestionsFor(p, universe) });
  }
  return { real, missing };
}
