/**
 * beads — deterministic beads (bd) issue-tree creation with ID capture in CODE.
 *
 * The workbench's create_execution leans on the model to fire dozens of `bd
 * create` calls and track the returned IDs to wire dependencies — exactly the
 * kind of long stateful sequence a small model loses track of. Here the tree is
 * planned with symbolic refs (pure, testable), then an executor creates issues
 * with `bd create --silent` (which prints ONLY the id), maps ref→real id, and
 * wires `bd dep add` from that map. The model never touches an id.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface Phase {
  name: string;
  tasks: string[];
}

export interface BeadsCreate {
  ref: string;
  title: string;
  type: string;
  parent?: string;
}

export interface BeadsDep {
  blocked: string; // ref that is blocked
  blocker: string; // ref that must finish first
}

export interface BeadsPlan {
  creates: BeadsCreate[];
  deps: BeadsDep[];
}

// bd ids are <prefix>-<suffix>; the prefix itself may contain hyphens
// (e.g. "workbench-pi-3nq"), so allow hyphens before the final segment.
const ID_RE = /^[A-Za-z][A-Za-z0-9-]*-[A-Za-z0-9]+$/;

/**
 * Extract every `id` string from any bd `--json` output — flat arrays (`bd list`,
 * `bd ready`) and nested trees (`bd dep tree`). Used to compute an epic's descendant
 * closure across both dependency and parent-child edges. Deduped.
 */
export function parseIds(jsonStr: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (typeof o.id === "string") out.push(o.id);
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    }
  };
  walk(data);
  return [...new Set(out)];
}

/** True if a string is shaped like a bd issue id (prefix-suffix, no slash/space). */
export function isBeadId(s: string): boolean {
  return ID_RE.test(s.trim());
}

/** Extract a bd issue id from `bd create --silent` output (last matching line). */
export function parseSilentId(stdout: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ID_RE.test(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * Plan an epic → phase-milestone → task tree. Creates are emitted in a
 * dependency-safe order (a parent always precedes its children). Each milestone
 * is blocked by its own tasks; each phase is blocked by the previous phase.
 */
export function planBeadsTree(epicTitle: string, phases: Phase[]): BeadsPlan {
  const creates: BeadsCreate[] = [{ ref: "epic", title: epicTitle, type: "epic" }];
  const deps: BeadsDep[] = [];

  phases.forEach((phase, pi) => {
    const phaseRef = `phase-${pi + 1}`;
    creates.push({ ref: phaseRef, title: `Phase ${pi + 1}: ${phase.name}`, type: "task", parent: "epic" });
    phase.tasks.forEach((task, ti) => {
      const taskRef = `${phaseRef}-task-${ti + 1}`;
      creates.push({ ref: taskRef, title: task, type: "task", parent: phaseRef });
      deps.push({ blocked: phaseRef, blocker: taskRef });
    });
    if (pi > 0) deps.push({ blocked: phaseRef, blocker: `phase-${pi}` });
  });

  return { creates, deps };
}

export interface BeadsExecResult {
  refToId: Record<string, string>;
  epicId: string;
  errors: string[];
}

/** Execute a BeadsPlan against the `bd` CLI, capturing ids deterministically. */
export async function createBeadsTree(
  pi: ExtensionAPI,
  cwd: string,
  plan: BeadsPlan,
  signal?: AbortSignal,
): Promise<BeadsExecResult> {
  const refToId: Record<string, string> = {};
  const errors: string[] = [];

  for (const c of plan.creates) {
    const args = ["create", c.title, "-t", c.type, "--silent"];
    if (c.parent && refToId[c.parent]) args.push("--parent", refToId[c.parent]);
    const r = await pi.exec("bd", args, { cwd, signal, timeout: 15_000 });
    const id = parseSilentId(r.stdout);
    if (!id) {
      errors.push(`create failed for "${c.title}": ${r.stderr || r.stdout || `exit ${r.code}`}`);
      continue;
    }
    refToId[c.ref] = id;
  }

  for (const d of plan.deps) {
    const blocked = refToId[d.blocked];
    const blocker = refToId[d.blocker];
    if (!blocked || !blocker) continue; // a create failed; skip silently (already in errors)
    const r = await pi.exec("bd", ["dep", "add", blocked, blocker], { cwd, signal, timeout: 15_000 });
    if (r.code !== 0) errors.push(`dep add ${blocked} <- ${blocker} failed: ${r.stderr || r.stdout}`);
  }

  return { refToId, epicId: refToId["epic"] ?? "", errors };
}
