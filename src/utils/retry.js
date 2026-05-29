export async function retryWithBackoff(fn, maxAttempts = 4, baseDelayMs = 300) {
  let lastError;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;

      const jitterMs = Math.floor(Math.random() * 101);
      const delayMs = Number(baseDelayMs || 0) * (2 ** (attempt - 1)) + jitterMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
