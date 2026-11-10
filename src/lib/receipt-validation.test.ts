// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_RECEIPT_BYTES, readReceiptFile } from "./expense";
describe("receipt input boundaries", () => {
  it("rejects oversize before reading, and rejects empty or unsupported uploads", async () => {
    const file = new File(["synthetic"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: MAX_RECEIPT_BYTES + 1 });
    await expect(readReceiptFile(file)).rejects.toThrow("50 MB");
    await expect(
      readReceiptFile(new File([], "empty.pdf", { type: "application/pdf" })),
    ).rejects.toThrow("empty");
    await expect(
      readReceiptFile(
        new File(["<svg/>"], "test.svg", { type: "image/svg+xml" }),
      ),
    ).rejects.toThrow("readable photo");
    await expect(
      readReceiptFile(
        new File(["synthetic"], "test.txt", { type: "text/plain" }),
      ),
    ).rejects.toThrow("readable photo");
  });
  it("rejects malformed PDF bytes including when MIME is inferred from filename", async () => {
    await expect(
      readReceiptFile(new File(["not a pdf"], "synthetic.pdf")),
    ).rejects.toThrow("Unreadable");
  });
});
