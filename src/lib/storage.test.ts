import { describe, expect, it } from "vitest";
import { emptyState, type MileageState } from "./model";
import {
  exportState,
  importState,
  loadState,
  saveState,
  STORAGE_KEY,
} from "./storage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const complete: MileageState = {
  version: 1,
  profile: {
    driverName: "Alex Morgan",
    businessName: "Biztech",
    vehicleDescription: "2024 Toyota RAV4",
    businessUseStartDate: "2026-01-01",
  },
  annualMileage: [{ year: 2026, opening_tenths: 10000, closing_tenths: 25000 }],
  trips: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      date: "2026-09-30",
      destination: "Sacramento, CA",
      businessPurpose: "Customer installation",
      start_tenths: 12000,
      end_tenths: 12100,
      parking_cents: 0,
      tolls_cents: 0,
      createdAt: "2026-09-30T12:00:00.000Z",
    },
  ],
};

describe("browser storage", () => {
  it("round-trips validated state", () => {
    const storage = new MemoryStorage();
    saveState(complete, storage);
    expect(loadState(storage)).toEqual(complete);
    expect(storage.getItem(STORAGE_KEY)).toBeTruthy();
  });
  it("returns a safe empty state for corrupt browser data", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{bad");
    expect(loadState(storage)).toEqual(emptyState());
  });
  it("exports and imports a portable validated backup", () => {
    expect(importState(exportState(complete))).toEqual(complete);
    expect(() => importState('{"version":1,"trips":[]}')).toThrow(/backup/i);
  });
});
