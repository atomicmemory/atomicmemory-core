/**
 * Shared vector math utilities used across embedding, search, and MMR modules.
 * Provides a single canonical implementation of cosine similarity to avoid
 * duplication across the codebase.
 */

/**
 * Cosine similarity between two vectors.
 * Returns 0 for empty, mismatched-length, or zero-magnitude vectors.
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
