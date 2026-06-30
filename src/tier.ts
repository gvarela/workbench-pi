/**
 * Tier switch — the single knob that decides how much the workflow leans on the
 * model's own CAPABILITY/judgment versus deterministic, extension-owned control flow.
 *
 * The axis is model capability, NOT whether a model is a "reasoning"/thinking model.
 * Sonnet, for instance, is a highly capable generalist that belongs on the capable
 * tier regardless of thinking-mode labels.
 *
 *   "small"   (default) — qwen3.6:35b-class local models. The extension owns
 *             control flow: narrow single-purpose subagents, deterministic
 *             assembly, path grounding, templated fill-in-the-blank output.
 *   "capable" — capable models (Opus/Sonnet/GPT-5/GLM-class, etc.). /wb-research
 *             and /wb-design become model-led (the model fans out and synthesizes
 *             the artifact itself); /wb-execution and /wb-implement keep the
 *             deterministic beads tree + verifier but run subagents on the
 *             stronger model.
 *
 * Invariant across tiers (NOT tier-dependent): path grounding, deterministic beads
 * id capture, and the discipline gates (which arm during /wb-implement and are
 * bypassable with /wb-override).
 *
 * Resolution order (first match wins):
 *   1. env WORKBENCH_TIER (small | capable, plus aliases) — the source of truth
 *   2. heuristic on the active model id — BEST-EFFORT for a few well-known capable
 *      families only. Capability isn't reliably encoded in model ids (Sonnet doesn't
 *      say "capable"; GLM-class models aren't listed), so for anything outside the
 *      known families set WORKBENCH_TIER explicitly.
 *   3. default "small"
 */

export type Tier = "small" | "capable";

// Best-effort: a few well-known capable families. Intentionally NOT exhaustive —
// unknown-but-capable models (e.g. GLM) opt in via WORKBENCH_TIER.
const CAPABLE_MODEL_HINTS = [
  "opus",
  "sonnet",
  "gpt-5",
  "gpt-4.1",
  "o1",
  "o3",
  "o4",
  "gemini-2.5-pro",
  "gemini-3",
  "deepseek-r",
];

export function normalizeTier(value: string | undefined): Tier | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "small" || v === "local" || v === "qwen") return "small";
  if (v === "capable" || v === "reasoning" || v === "frontier" || v === "large") return "capable";
  return undefined;
}

export function tierFromModelId(modelId: string | undefined): Tier {
  if (!modelId) return "small";
  const id = modelId.toLowerCase();
  return CAPABLE_MODEL_HINTS.some((hint) => id.includes(hint)) ? "capable" : "small";
}

/**
 * Resolve the active tier. `modelId` is the currently selected model (e.g.
 * "ollama/qwen3.6:35b-mlx"); pass it from ctx.model when available.
 */
export function resolveTier(modelId?: string): Tier {
  return normalizeTier(process.env.WORKBENCH_TIER) ?? tierFromModelId(modelId);
}
