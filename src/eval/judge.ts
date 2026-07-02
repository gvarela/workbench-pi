/**
 * eval/judge — LLM-as-judge for the subjective dimensions the deterministic scorers
 * can't measure. The judge is the MEASUREMENT INSTRUMENT and always runs on a
 * capable model, independent of the target model that produced the artifact.
 *
 * Pure here: the rubric prompt builder and a defensive verdict parser. The actual
 * (capable-model, opt-in, cached) call lives in the runner.
 */

// `as`-cast rather than a `: Record<…>` annotation: `node --check` (the validate
// syntax gate) can't strip a generic annotation on a const, but strips casts fine.
const RUBRICS = {
  research: ["accuracy", "completeness", "usefulness"],
  design: ["addresses_research", "decision_clarity", "scoping"],
  tasks: ["ordering", "granularity", "testability"],
} as Record<string, string[]>;

export function judgeDimensions(artifactType: string): string[] {
  return RUBRICS[artifactType] ?? ["quality"];
}

/** Build a strict-JSON grading prompt for a capable judge model. */
export function judgePrompt(artifactType: string, content: string, context?: string): string {
  const dims = judgeDimensions(artifactType);
  return [
    `You are grading a workbench "${artifactType}" artifact. Judge ONLY the subjective quality below;`,
    `do not check file paths (that is measured separately).`,
    context ? `\nContext:\n${context}\n` : "",
    `\nArtifact:\n"""\n${content}\n"""\n`,
    `Score each dimension from 0.0 (poor) to 1.0 (excellent), citing brief evidence.`,
    `Dimensions: ${dims.join(", ")}.`,
    `Respond with ONLY a JSON object, no prose, in exactly this shape:`,
    `{"dimensions": {${dims.map((d) => `"${d}": 0.0`).join(", ")}}, "notes": "<1-2 sentences>"}`,
  ].join("\n");
}

export interface JudgeVerdict {
  dimensions: Record<string, number>;
  notes?: string;
  average: number;
}

/** Defensively parse a judge reply: extract the first {...} block, validate, average. */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const dimsRaw = (obj as Record<string, unknown>).dimensions;
  if (!dimsRaw || typeof dimsRaw !== "object") return null;
  const dimensions = {} as Record<string, number>;
  for (const [k, v] of Object.entries(dimsRaw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) dimensions[k] = Math.max(0, Math.min(1, v));
  }
  const vals = Object.values(dimensions);
  if (vals.length === 0) return null;
  const average = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  const notesRaw = (obj as Record<string, unknown>).notes;
  return { dimensions, notes: typeof notesRaw === "string" ? notesRaw : undefined, average };
}
