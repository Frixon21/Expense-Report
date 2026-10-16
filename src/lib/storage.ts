import { emptyState, mileageStateSchema, type MileageState } from "./model";

export const STORAGE_KEY = "biztech-mileage-v1";

const browserStorage = () => {
  if (typeof window === "undefined")
    throw new Error("Browser storage is unavailable.");
  return window.localStorage;
};

export function loadState(storage: Storage = browserStorage()): MileageState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = mileageStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyState();
  } catch {
    return emptyState();
  }
}

export function saveState(
  state: MileageState,
  storage: Storage = browserStorage(),
) {
  const valid = mileageStateSchema.parse(state);
  storage.setItem(STORAGE_KEY, JSON.stringify(valid));
}

export function exportState(state: MileageState) {
  return JSON.stringify(mileageStateSchema.parse(state), null, 2);
}

export function importState(raw: string): MileageState {
  try {
    const result = mileageStateSchema.safeParse(JSON.parse(raw));
    if (!result.success) throw new Error();
    return result.data;
  } catch {
    throw new Error("This backup file is not a valid Mileage Log backup.");
  }
}
