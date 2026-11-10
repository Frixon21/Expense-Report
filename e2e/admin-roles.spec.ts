import { test, expect, type Page } from "@playwright/test";
async function setup(page: Page, roles: string[]) {
  const user = {
    id: "admin-fixture",
    displayName: "Synthetic Admin Alice",
    email: "alice@example.test",
    roles,
    accessStatus: "active",
  };
  const requests: string[] = [];
  const common = {
    createdAt: "2026-10-27T12:00:00.000Z",
    subjectUserId: "target",
    subjectName: "Synthetic Bob",
    subjectEmail: "bob@example.test",
    actorName: "Synthetic Admin Alice",
    actorEmail: "alice@example.test",
  };
  const events = [
    {
      ...common,
      id: "admin-roles",
      eventType: "user_access_updated",
      details: { roles: ["employee", "payroll"], accessStatus: "active" },
    },
    {
      ...common,
      id: "private-pay",
      eventType: "payroll_mark_paid",
      actorName: "Hidden payroll actor",
      subjectName: "Hidden payroll employee",
      details: { amount: 123456, reason: "PRIVATE-PAYROLL-PAYLOAD" },
    },
    {
      ...common,
      id: "private-rate",
      eventType: "mileage_rate_created",
      subjectUserId: null,
      subjectName: null,
      subjectEmail: null,
      details: { centsPerMile: 77, marker: "PRIVATE-RATE-PAYLOAD" },
    },
    {
      ...common,
      id: "private-repair",
      eventType: "record_repaired",
      details: { merchant: "PRIVATE-REPAIR-PAYLOAD" },
    },
  ];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === "/api/auth/me")
      return route.fulfill({ json: { authenticated: true, user } });
    if (
      url.pathname === "/api/admin/users/" + user.id &&
      route.request().method() === "PATCH"
    ) {
      const body = route.request().postDataJSON();
      if (Array.isArray(body.roles)) user.roles = [...body.roles];
      events.unshift({
        ...common,
        id: "role-edit-" + events.length,
        eventType: "user_access_updated",
        subjectUserId: user.id,
        subjectName: user.displayName,
        subjectEmail: user.email,
        details: { roles: user.roles, accessStatus: "active" },
      } as (typeof events)[number]);
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/admin/access")
      return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/api/admin/users")
      return route.fulfill({
        json: {
          users: [
            {
              id: user.id,
              displayName: user.displayName,
              email: user.email,
              roles: user.roles,
              accessStatus: "active",
            },
          ],
        },
      });
    if (url.pathname === "/api/admin/audit")
      return route.fulfill({
        json: {
          events,
          page: 1,
          pageSize: 25,
          total: events.length,
          totalPages: 1,
        },
      });
    if (url.pathname === "/api/me")
      return route.fulfill({
        json: {
          user,
          state: {
            version: 1,
            profile: {
              driverName: "Synthetic Employee",
              businessName: "Biztech",
              vehicleDescription: "Synthetic car",
              businessUseStartDate: "2026-01-01",
            },
            annualMileage: [],
            trips: [],
          },
          expenses: [],
          history: [],
        },
      });
    if (url.pathname === "/api/payroll")
      return route.fulfill({
        json: {
          employees: [],
          rates: [],
          trips: [],
          expenses: [],
          history: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: "No synthetic endpoint" },
    });
  });
  await page.goto("/");
  return requests;
}
test("pure admin defaults to Administration and conceals payroll details without deleting audit rows", async ({
  page,
}) => {
  const requests = await setup(page, ["super_admin"]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toHaveCount(0);
  const table = page.locator(".admin-audit-table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(table.getByText("Payroll only", { exact: true })).toHaveCount(3);
  await expect(
    table.getByRole("columnheader", { name: "Performed by", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("columnheader", { name: "Affected account", exact: true }),
  ).toBeVisible();
  await table.getByText("View details", { exact: true }).click();
  await expect(table.locator("pre")).toContainText('"payroll"');
  await expect(table.locator("pre")).toHaveCount(1);
  expect(await table.evaluate((el) => el.outerHTML)).not.toMatch(
    /PRIVATE-|Hidden payroll|123456|payroll_mark_paid|mileage_rate_created|record_repaired/,
  );
  await expect(
    page.getByLabel("Search history", { exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Event", { exact: true }).fill("user_access_updated");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect
    .poll(() =>
      requests.some((url) => url.includes("event=user_access_updated")),
    )
    .toBe(true);
  expect(requests.some((url) => url.startsWith("/api/payroll"))).toBe(false);
  expect(
    requests
      .filter((url) => url.startsWith("/api/admin/audit"))
      .every((url) => !new URL(url, "http://synthetic").searchParams.has("q")),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/admin-without-payroll.png",
    fullPage: true,
  });
});
test("admin plus explicit Payroll sees payroll audit details and can navigate to Payroll", async ({
  page,
}) => {
  await setup(page, ["super_admin", "payroll"]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  const table = page.locator(".admin-audit-table");
  await expect(table.getByText("Payroll only", { exact: true })).toHaveCount(0);
  const row = table
    .locator("tbody tr")
    .filter({ hasText: "payroll_mark_paid" });
  await row.getByText("View details", { exact: true }).click();
  await expect(row.locator("pre")).toContainText("PRIVATE-PAYROLL-PAYLOAD");
  await expect(
    page.getByLabel("Search history", { exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Payroll", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Payroll/ }).first(),
  ).toBeVisible();
});
test("employee has neither administration nor payroll navigation or audit requests", async ({
  page,
}) => {
  const requests = await setup(page, ["employee"]);
  await expect(
    page.getByRole("heading", { name: "Mileage log", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Admin", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toHaveCount(0);
  expect(
    requests.some(
      (url) => url.startsWith("/api/admin") || url.startsWith("/api/payroll"),
    ),
  ).toBe(false);
});

test("normal role editor saves and reloads explicit Payroll self-grants/removals without losing Super admin", async ({
  page,
}) => {
  await setup(page, ["super_admin", "payroll"]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  let roles = page.getByRole("group", {
    name: "Roles for Synthetic Admin Alice",
    exact: true,
  });
  await roles.getByRole("checkbox", { name: "Payroll", exact: true }).uncheck();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Save roles", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toHaveCount(0);
  roles = page.getByRole("group", {
    name: "Roles for Synthetic Admin Alice",
    exact: true,
  });
  await expect(
    roles.getByRole("checkbox", { name: "Payroll", exact: true }),
  ).not.toBeChecked();
  await expect(
    roles.getByRole("checkbox", { name: "Super admin", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .locator(".admin-audit-table")
      .getByText("Payroll only", { exact: true }),
  ).toHaveCount(3);
  await roles.getByRole("checkbox", { name: "Payroll", exact: true }).check();
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Save roles", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toBeVisible();
  const audit = page.locator(".admin-audit-table");
  await expect(audit.getByText("Payroll only", { exact: true })).toHaveCount(0);
  await expect(
    audit.locator("tbody tr").filter({ hasText: "user_access_updated" }),
  ).toHaveCount(3);
  await page.screenshot({
    path: "test-results/explicit-roles-save-reload.png",
    fullPage: true,
  });
});

test("unchanged role save reloads fresh session data and preserves existing selections", async ({
  page,
}) => {
  const requests = await setup(page, ["super_admin", "payroll"]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  const before = await page.evaluate(() => performance.timeOrigin);
  const authCount = requests.filter((url) => url === "/api/auth/me").length;
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.getByRole("button", { name: "Save roles", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(
    before,
  );
  expect(
    requests.filter((url) => url === "/api/auth/me").length,
  ).toBeGreaterThan(authCount);
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", {
        name: "Roles for Synthetic Admin Alice",
        exact: true,
      })
      .getByRole("checkbox", { name: "Payroll", exact: true }),
  ).toBeChecked();
});

test("failed role save keeps its error and unsaved selections without reloading", async ({
  page,
}) => {
  await setup(page, ["super_admin", "payroll"]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  await page.route("**/api/admin/users/admin-fixture", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Synthetic role save failure" },
    }),
  );
  const before = await page.evaluate(() => performance.timeOrigin);
  const roles = page.getByRole("group", {
    name: "Roles for Synthetic Admin Alice",
    exact: true,
  });
  await roles.getByRole("checkbox", { name: "Payroll", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save roles", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText(
    "Synthetic role save failure",
  );
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  await expect(
    roles.getByRole("checkbox", { name: "Payroll", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Save roles", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toBeVisible();
});

async function twoAccounts(page: Page) {
  const self = {
    id: "admin-fixture",
    displayName: "Synthetic Admin Alice",
    email: "alice@example.test",
    roles: ["super_admin", "payroll"],
    accessStatus: "active",
  };
  const other = {
    id: "other-fixture",
    displayName: "Synthetic Other Bob",
    email: "other@example.test",
    roles: ["employee"],
    accessStatus: "active",
  };
  await page.route("**/api/admin/users", (route) =>
    route.fulfill({ json: { users: [self, other] } }),
  );
  await page.route("**/api/admin/users/other-fixture", (route) => {
    other.roles = route.request().postDataJSON().roles;
    return route.fulfill({ json: other });
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  return { self, other };
}
test("saving another account reloads updated role tiles while preserving current session roles", async ({
  page,
}) => {
  await setup(page, ["super_admin", "payroll"]);
  await twoAccounts(page);
  const row = page
    .locator(".admin-user-row")
    .filter({ hasText: "Synthetic Other Bob" });
  await row.getByRole("checkbox", { name: "Payroll", exact: true }).check();
  const before = await page.evaluate(() => performance.timeOrigin);
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    row.getByRole("button", { name: "Save roles", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Administration", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(
    before,
  );
  await expect(
    row.getByRole("checkbox", { name: "Payroll", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Payroll", exact: true }),
  ).toBeVisible();
});

test("verified role tiles and payroll filter container stay dark with populated controls", async ({
  page,
}) => {
  await setup(page, ["super_admin", "payroll"]);
  await page.route("**/api/admin/access", (route) =>
    route.fulfill({
      json: {
        requests: [
          {
            request_id: "pending-synthetic",
            user_id: "pending",
            display_name: "Synthetic Pending",
            email: "pending@example.test",
            requested_at: "2026-10-27T12:00:00Z",
          },
        ],
      },
    }),
  );
  await twoAccounts(page);
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.selectOption("dark");
  const tiles = page.locator(".admin-role-list .admin-option");
  await expect(tiles).toHaveCount(6);
  for (const tile of await page.locator(".admin-option").all())
    await expect(tile).toHaveCSS("background-color", "rgb(36, 57, 87)");
  await page.screenshot({
    path: "test-results/dark-role-tiles.png",
    fullPage: true,
  });
  await theme.selectOption("light");
  await expect(tiles.first()).toHaveCSS(
    "background-color",
    "rgb(248, 250, 252)",
  );
  await theme.selectOption("dark");
  await page.getByRole("button", { name: "Payroll", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Submitted and processed records",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".payroll-empty-state")).toHaveCSS(
    "background-color",
    "rgb(26, 38, 56)",
  );
  const filters = page.locator(".payroll-record-filters");
  await expect(filters).toHaveCSS("background-color", "rgb(36, 52, 75)");
  await expect(filters.locator('input[type="search"]')).toHaveCSS(
    "background-color",
    "rgb(26, 38, 56)",
  );
  await expect(
    filters.getByRole("button", { name: "Clear filters", exact: true }),
  ).toHaveCSS("background-color", "rgb(26, 38, 56)");
  await page.screenshot({
    path: "test-results/dark-payroll-filter-wrapper.png",
    fullPage: true,
  });
  await theme.selectOption("light");
  await expect(filters).toHaveCSS("background-color", "rgb(250, 251, 253)");
});
