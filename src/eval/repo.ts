/**
 * eval/repo — git-backed universe of real paths for grounding checks. Shared by
 * the single-artifact CLI and the fixture runner.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function git(root: string, args: string[]): string[] {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function repoRoot(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Real paths = tracked + untracked-visible files, PLUS any cited path that exists on
 * disk (so grounding measures hallucination, not gitignore status).
 */
export function repoUniverse(dir: string, citedPaths: string[]): string[] {
  const root = repoRoot(dir);
  if (!root) return [];
  const set = new Set([...git(root, ["ls-files"]), ...git(root, ["ls-files", "--others", "--exclude-standard"])]);
  for (const p of citedPaths) if (existsSync(join(root, p))) set.add(p);
  return [...set];
}
