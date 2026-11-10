import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { newId } from "./new-id";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
afterEach(() => vi.unstubAllGlobals());
describe("newId", () => {
  it("uses the native cryptographic UUID when available", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });
    expect(newId()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    () => {
      throw new DOMException("Not allowed", "SecurityError");
    },
  ])(
    "uses getRandomValues when randomUUID is missing or rejected",
    (randomUUID) => {
      const getRandomValues = vi.fn((bytes: Uint8Array) => {
        bytes.fill(255);
        return bytes;
      });
      vi.stubGlobal("crypto", { randomUUID, getRandomValues });
      expect(newId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
      expect(getRandomValues).toHaveBeenCalledOnce();
    },
  );
  it("generates distinct valid UUIDs using only the browser-compatible secure fallback", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(uuid);
  });
  it.each([undefined, {}])(
    "fails clearly without a cryptographic random source",
    (crypto) => {
      vi.stubGlobal("crypto", crypto);
      expect(newId).toThrow("cannot generate a secure identifier");
    },
  );
});
