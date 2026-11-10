/** Cryptographically random UUID v4, including HTTP LAN origins without randomUUID. */
export function newId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Older browsers may expose randomUUID but reject it for this origin.
    }
  }
  if (typeof source?.getRandomValues !== "function") {
    throw new Error(
      "This browser cannot generate a secure identifier. Use a supported browser and try again.",
    );
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
