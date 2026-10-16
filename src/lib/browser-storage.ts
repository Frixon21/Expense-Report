export function probeBrowserStorage(storage?: Storage): string | null {
  if (typeof window === "undefined") return null;
  const target = storage ?? window.localStorage;
  try {
    const key = "__biztech_storage_probe__";
    target.setItem(key, "1");
    target.removeItem(key);
    return null;
  } catch {
    return "Browser storage is disabled or full on this device. Saves cannot be stored.";
  }
}
