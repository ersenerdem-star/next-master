// A committed mutation and a best-effort list refresh have different outcomes.
// Never encourage repeating a successful write because its follow-up read failed.
export async function refreshAfterCommit<T>(refresh: () => Promise<T>, timeoutMs = 5000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      refresh(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("POST_COMMIT_REFRESH_TIMEOUT")), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
