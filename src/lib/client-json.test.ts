import { afterEach, expect, it, vi } from "vitest";
import { clientJson, CLIENT_REQUEST_TIMEOUT_MS } from "./client-json";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("settles stalled headers even when fetch ignores abort", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_input: RequestInfo | URL, _options?: RequestInit) => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetcher);
  const outcome = expect(clientJson("/api/auth/me")).rejects.toThrow("took too long");
  await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
  await outcome;
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("also bounds a stalled response body", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const outcome = expect(clientJson("/api/auth/me")).rejects.toThrow("took too long");
  await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS); await outcome;
});

it("cancels on cleanup without leaving a deadline timer", async () => {
  vi.useFakeTimers(); vi.stubGlobal("fetch", () => new Promise(() => {}));
  const controller = new AbortController();
  const outcome = expect(clientJson("/api/auth/me", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort(); await outcome; expect(vi.getTimerCount()).toBe(0);
});

it("reports HTTP and malformed response errors and returns successful JSON", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "Synthetic service unavailable" }, { status: 503 }));
  await expect(clientJson("/api/auth/me")).rejects.toThrow("Synthetic service unavailable");
  vi.stubGlobal("fetch", async () => new Response("not-json"));
  await expect(clientJson("/api/auth/me")).rejects.toThrow("invalid response");
  vi.stubGlobal("fetch", async () => Response.json({ authenticated: false }));
  await expect(clientJson("/api/auth/me")).resolves.toEqual({ authenticated: false });
});
