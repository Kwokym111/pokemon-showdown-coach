// review-cache.js: decides whether a saved, AI-explained review can be reused. Pure.
//
// The review is always rebuilt from the log (it takes ~30 ms), and only the AI text is
// reused. If the rules changed since the cache was written, the moments no longer match and
// the cache is ignored, so old explanations can never end up on new moments.

const momentKey = (m) => `${m.turn}|${m.rule}|${m.label}|${m.mon}`;

// Returns a new review with the cached summary and explanations filled in, or null when the
// cache cannot be trusted for this review.
function applyCachedExplanations(review, cached) {
  if (!review || !cached || cached.aiUsed !== true) return null;
  if (typeof cached.summary !== 'string' || !cached.summary) return null;
  if (!Array.isArray(cached.moments) || cached.moments.length !== review.moments.length) return null;

  const same = review.moments.every((m, i) => {
    const c = cached.moments[i];
    return c && momentKey(c) === momentKey(m) && typeof c.explanation === 'string' && c.explanation;
  });
  if (!same) return null;

  return {
    ...review,
    aiUsed: true,
    // keep naming the model after a reload from the saved file (older caches have none)
    ...(typeof cached.aiModel === 'string' && cached.aiModel ? { aiModel: cached.aiModel } : {}),
    summary: cached.summary,
    moments: review.moments.map((m, i) => ({ ...m, explanation: cached.moments[i].explanation })),
  };
}

module.exports = { applyCachedExplanations };
