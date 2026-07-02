/**
 * eval/scorers — deterministic, free quality scorers for generated artifacts.
 *
 * These do the bulk of grading without a model: path-grounding correctness (the
 * central anti-hallucination metric), facts-only discipline, template conformance,
 * and leftover-placeholder detection. An LLM-as-judge layer for subjective quality
 * can sit on top later; keeping the deterministic checks separate means most of the
 * scorecard costs nothing and is unit-testable.
 */

import { groundPaths } from "../tools/verify-paths.ts";

const PATH_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|md|json|sh|yml|yaml|toml|txt|css|html)$/i;
const OPINION_RE =
  /\b(should|shouldn'?t|recommend|recommended|i think|we could|we should|better to|it'?s best|best to|prefer to|ought to|in my opinion|ideally|consider (?:refactor|adding|using|moving))\b/gi;
const PLACEHOLDER_RE = /(_\(no findings\)_|_Populate with|\bTODO\b|\bFIXME\b|\bXXX\b|\[fill in\])/gi;

export interface DimScore {
  score: number;
}

/** Backticked tokens that look like file paths (have a slash or a known extension); :line stripped. */
export function extractCitedPaths(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^`]+)`/g)) {
    const raw = m[1].trim();
    // strip a trailing :line or :line-range (ascii hyphen, en-dash, em-dash)
    const path = raw.replace(/:\d+(?:[-–—]\d+)?$/, "");
    if (/\s/.test(path)) continue; // tokens with spaces aren't paths
    if (path.includes("/") || PATH_EXT_RE.test(path)) out.add(path);
  }
  return [...out];
}

export function scorePathGrounding(md: string, universe: string[]): DimScore & { cited: number; grounded: number } {
  const cited = extractCitedPaths(md);
  const { real } = groundPaths(cited, universe);
  const grounded = real.length;
  return { cited: cited.length, grounded, score: cited.length === 0 ? 1 : grounded / cited.length };
}

export function scoreFactsOnly(md: string): DimScore & { violations: number } {
  const violations = (md.match(OPINION_RE) ?? []).length;
  return { violations, score: violations === 0 ? 1 : Math.max(0, 1 - 0.25 * violations) };
}

export function scoreTemplateConformance(md: string, requiredHeadings: string[]): DimScore & { present: number; required: number } {
  const present = requiredHeadings.filter((h) => md.includes(h)).length;
  return { present, required: requiredHeadings.length, score: requiredHeadings.length === 0 ? 1 : present / requiredHeadings.length };
}

export function scorePlaceholders(md: string): DimScore & { leftover: number } {
  const leftover = (md.match(PLACEHOLDER_RE) ?? []).length;
  return { leftover, score: leftover === 0 ? 1 : Math.max(0, 1 - 0.25 * leftover) };
}

export interface ScorecardOptions {
  universe: string[];
  requiredHeadings?: string[];
}

export interface Scorecard {
  pathGrounding: ReturnType<typeof scorePathGrounding>;
  factsOnly: ReturnType<typeof scoreFactsOnly>;
  templateConformance: ReturnType<typeof scoreTemplateConformance>;
  placeholders: ReturnType<typeof scorePlaceholders>;
  overall: number;
}

export function scorecard(md: string, opts: ScorecardOptions): Scorecard {
  const pathGrounding = scorePathGrounding(md, opts.universe);
  const factsOnly = scoreFactsOnly(md);
  const templateConformance = scoreTemplateConformance(md, opts.requiredHeadings ?? []);
  const placeholders = scorePlaceholders(md);
  const overall =
    Math.round(((pathGrounding.score + factsOnly.score + templateConformance.score + placeholders.score) / 4) * 100) / 100;
  return { pathGrounding, factsOnly, templateConformance, placeholders, overall };
}
