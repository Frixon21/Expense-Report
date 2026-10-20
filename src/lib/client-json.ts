export const CLIENT_REQUEST_TIMEOUT_MS = 12_000;

/** Bound both response headers and body; abort alone may not settle a stalled fetch. */
export async function clientJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      abortListener = () => { controller.abort(); reject(new DOMException("Request cancelled.", "AbortError")); };
      if (signal?.aborted) return abortListener();
      signal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => {
        reject(new Error("The request took too long. Please try again."));
        controller.abort();
      }, CLIENT_REQUEST_TIMEOUT_MS);
    });
    const read = async () => {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const value = await response.json().catch(() => { throw new Error("The server returned an invalid response. Please try again."); });
      if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "The request failed. Please try again.");
      return value as T;
    };
    return await Promise.race([deadline, read()]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}
