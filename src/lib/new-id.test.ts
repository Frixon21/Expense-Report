import { describe, expect, it, vi } from "vitest";
import { newId } from "./new-id";

describe("newId", () => {
  it("returns a uuid-shaped string when randomUUID is unavailable", () => {
    const original = globalThis.crypto?.randomUUID;
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => {
        throw new DOMException("Not allowed", "SecurityError");
      },
    });
    const id = newId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    if (original) {
      vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: original });
    }
  });
});
