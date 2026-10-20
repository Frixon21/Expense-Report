import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`session timeout and retry recover at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.clock.install();
    let retry = false;
    await page.route("**/api/auth/me", (route) => retry ? route.fulfill({ json: { authenticated: false } }) : undefined);
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Checking your app session");
    await page.clock.fastForward(12_001);
    await expect(page.getByRole("heading", { name: "Could not check your session" })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    retry = true;
    await page.getByRole("button", { name: "Retry session check" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Expense Report" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("failed sign-out remains visible until the server confirms logout", async ({ page }) => {
  let fail = true;
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { authenticated: true, user: { id: "synthetic-pending", displayName: "Synthetic", roles: [], accessStatus: "pending" } } }));
  await page.route("**/api/admin/bootstrap/availability", (route) => route.fulfill({ json: { available: false } }));
  await page.route("**/api/auth/logout", (route) => fail ? route.fulfill({ status: 503, json: { error: "Synthetic logout failure" } }) : route.fulfill({ json: { ok: true } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic logout failure" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waiting for Expense Report access" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Expense Report" })).toBeVisible();
});

test("synthetic sign-in submits an employee expense through the app API", async ({ page }) => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "Synthetic Employee",
    email: "synthetic@example.test",
    accessStatus: "active",
    roles: ["employee"],
  };
  const state = {
    version: 1,
    profile: {
      driverName: "Synthetic Employee",
      businessName: "Biztech",
      vehicleDescription: "Synthetic vehicle",
      businessUseStartDate: "2026-01-01",
    },
    annualMileage: [],
    trips: [],
  };
  let submitted: { userId?: string; state: unknown; expenses: Array<{ merchant: string }> } | null = null;

  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/auth/login", (route) => route.fulfill({ json: { authenticated: true, user } }));
  await page.route("**/api/me", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { user, state, expenses: [], history: [] } });
      return;
    }
    const body = route.request().postDataJSON() as {
      userId?: string;
      state: unknown;
      expenses: Array<{ merchant: string }>;
    };
    submitted = body;
    await route.fulfill({ json: { state: body.state, expenses: body.expenses, history: [] } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Expense Report" })).toBeVisible();
  await page.getByLabel("BT Auth username").fill("synthetic@example.test");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-only-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("tab", { name: "Expenses" })).toBeVisible();

  await page.getByRole("tab", { name: "Expenses" }).click();
  await page.getByLabel("Date", { exact: true }).fill("2026-10-16");
  await page.getByLabel("Amount", { exact: true }).fill("42.50");
  await page.getByRole("combobox", { name: "Paid with" }).selectOption("personal_card");
  await page.getByLabel("Merchant or description").fill("Synthetic Office Shop");
  await page.getByLabel("Business purpose").fill("Synthetic office supplies");
  await page.getByRole("button", { name: "Save expense" }).click();

  await expect(page.getByText("Synthetic Office Shop")).toBeVisible();
  const responseBody = () => submitted as {
    userId?: string;
    state: unknown;
    expenses: Array<{ merchant: string }>;
  } | null;
  await expect.poll(() => responseBody()?.expenses.length ?? 0).toBe(1);
  expect(responseBody()?.expenses[0]?.merchant).toBe("Synthetic Office Shop");
  expect(responseBody()).not.toHaveProperty("userId");
});
