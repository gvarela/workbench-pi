/**
 * Tier switch — the single knob that decides how much the workflow leans on the
 * model's own judgment versus deterministic, extension-owned control flow.
 *
 *   "small"     (default) — qwen3.6:35b-class local models. The extension owns
 *               control flow: narrow single-purpose subagents, deterministic
 *               assembly, path grounding, templated fill-in-the-blank output.
 *   "reasoning" — frontier reasoning models (Opus/Sonnet). /wb-research and
 *               /wb-design become model-led (the model fans out and synthesizes
 *               the artifact itself); /wb-execution and /wb-implement keep the
 *               deterministic beads tree + verifier but run subagents on the
 *               stronger model.
 *
 * Invariant across tiers (NOT tier-dependent): path grounding, deterministic
 * beads id capture, and the discipline gates (which arm during /wb-implement and
 * are bypassable with /wb-override).
 *
 * Resolution order (first match wins):
 *   1. env WORKBENCH_TIER
 *   2. heuristic on the active model id (anthropic/openai/gemini reasoning families
 *      → "reasoning"; everything else → "small")
 *   3. default "small"
 */

export type Tier = "small" | "reasoning";

const REASONING_MODEL_HINTS = [
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
  if (v === "reasoning" || v === "frontier" || v === "large") return "reasoning";
  return undefined;
}

export function tierFromModelId(modelId: string | undefined): Tier {
  if (!modelId) return "small";
  const id = modelId.toLowerCase();
  return REASONING_MODEL_HINTS.some((hint) => id.includes(hint)) ? "reasoning" : "small";
}

/**
 * Resolve the active tier. `modelId` is the currently selected model (e.g.
 * "ollama/qwen3.6:35b-mlx"); pass it from ctx.model when available.
 */
export function resolveTier(modelId?: string): Tier {
  return normalizeTier(process.env.WORKBENCH_TIER) ?? tierFromModelId(modelId);
}
