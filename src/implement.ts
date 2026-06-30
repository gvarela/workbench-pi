/**
 * implement — pure helpers for the coordinated /wb-implement loop.
 *
 * The coordinator reads ready work from `bd ready --json`, dispatches a fresh
 * worker per task, then a verifier whose verdict gates whether the bead closes.
 * Parsing bd output and the verifier verdict are kept pure and tested here.
 */

export interface ReadyIssue {
  id: string;
  title: string;
}

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";

/** Parse `bd ready --json` (array or {issues:[]}) into {id,title}. */
export function parseReadyIssues(stdout: string): ReadyIssue[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { issues?: unknown[] }).issues)
      ? (data as { issues: unknown[] }).issues
      : [];
  const out: ReadyIssue[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : undefined;
    if (!id) continue;
    const title = [o.title, o.summary, o.description].find((v) => typeof v === "string") as string | undefined;
    out.push({ id, title: title ?? "" });
  }
  return out;
}

/** Read the verifier's verdict; the "Verdict" section is authoritative, FAIL wins. */
export function parseVerdict(text: string): Verdict {
  const idx = text.toLowerCase().lastIndexOf("verdict");
  const scope = idx === -1 ? text : text.slice(idx);
  if (/\bFAIL\b/.test(scope)) return "FAIL";
  if (/\bPASS\b/.test(scope)) return "PASS";
  return "UNKNOWN";
}
