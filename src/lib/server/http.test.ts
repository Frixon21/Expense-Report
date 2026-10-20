import { expect, it } from "vitest";
import { MAX_EMPLOYEE_REQUEST_BYTES, requestJson } from "./http";

it("bounds declared and streamed bodies, even without a trustworthy Content-Length", async () => {
  const declared = new Request("http://localhost", { method: "POST", headers: { "content-length": "20000" }, body: "{}" });
  await expect(requestJson(declared)).rejects.toMatchObject({ status: 413 });
  for (const length of [undefined, "1"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(10_000)); controller.enqueue(new Uint8Array(10_000)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("http://localhost", { method: "POST", body, duplex: "half", headers: length ? { "content-length": length } : {} } as RequestInit);
    await expect(requestJson(request)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  }
});

it("retains the larger authenticated employee payload allowance and reports malformed JSON", async () => {
  const value = { receipt: "x".repeat(20_000) };
  const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify(value) });
  await expect(requestJson(request())).rejects.toMatchObject({ status: 413 });
  await expect(requestJson(request(), MAX_EMPLOYEE_REQUEST_BYTES)).resolves.toEqual(value);
  await expect(requestJson(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toBeInstanceOf(SyntaxError);
});
