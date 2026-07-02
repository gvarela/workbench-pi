/**
 * eval/compare — pure A/B aggregation over repeated runs.
 *
 * Small models are non-deterministic, so a single run is unreliable. We collect N
 * overall scores per variant and compare means against run-to-run noise, so a delta
 * only counts as "better" when it clears the pooled spread.
 */

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export interface Comparison {
  meanA: number;
  meanB: number;
  delta: number; // B - A
  noise: number; // pooled stdev
  significant: boolean; // |delta| clears the noise floor
  winner: "A" | "B" | "tie";
}

/**
 * Compare two variants' overall-score samples. `delta > noise` is a coarse but
 * honest bar — with N=1 (noise 0) any nonzero delta reads as significant, which is
 * why the runner defaults to N>1 when a verdict matters.
 */
export function compareVariants(scoresA: number[], scoresB: number[]): Comparison {
  const meanA = Math.round(mean(scoresA) * 1000) / 1000;
  const meanB = Math.round(mean(scoresB) * 1000) / 1000;
  const delta = Math.round((meanB - meanA) * 1000) / 1000;
  const noise = Math.round(Math.max(stdev(scoresA), stdev(scoresB)) * 1000) / 1000;
  const significant = Math.abs(delta) > noise;
  const winner = !significant ? "tie" : delta > 0 ? "B" : "A";
  return { meanA, meanB, delta, noise, significant, winner };
}
