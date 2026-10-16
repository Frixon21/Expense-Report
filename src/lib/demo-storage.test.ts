// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createDemoOrg } from "./demo-seed";
import { DEMO_STORAGE_KEY, loadDemoOrg, saveDemoOrg } from "./demo-storage";
import { expenseInputSchema } from "./expense";

describe("demo storage", () => {
  it("saves seeded org and new expenses", () => {
    const org = createDemoOrg();
    saveDemoOrg(org);
    const parsed = expenseInputSchema.parse({
      date: "2026-10-01",
      category: "supplies",
      amount: "12.50",
      paymentMethod: "personal_card",
      merchant: "Test Shop",
      businessPurpose: "Demo purchase",
      projectOrClient: "",
      notes: "",
    });
    const employee = org.employees[0];
    const next = {
      ...org,
      employees: org.employees.map((item) =>
        item.id === employee.id
          ? {
              ...item,
              expenses: [
                ...item.expenses,
                {
                  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
                  createdAt: new Date().toISOString(),
                  ...parsed,
                },
              ],
            }
          : item,
      ),
    };
    expect(() => saveDemoOrg(next)).not.toThrow();
    const loaded = loadDemoOrg();
    expect(loaded.employees[0].expenses.some((e) => e.merchant === "Test Shop")).toBe(
      true,
    );
    localStorage.removeItem(DEMO_STORAGE_KEY);
  });
});
