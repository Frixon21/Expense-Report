/** UUID v4 for records. Works on http:// LAN hosts where randomUUID is blocked. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Non-secure context (e.g. http://192.168.x.x) throws in some browsers.
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.trunc(Math.random() * 16);
    if (char === "x") return random.toString(16);
    return ((random & 0x3) | 0x8).toString(16);
  });
}
