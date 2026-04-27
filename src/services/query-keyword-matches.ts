/**
 * Shared query keyword matching utilities for retrieval-time reranking.
 */

export function countKeywordMatches(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword)).length;
}
