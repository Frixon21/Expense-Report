import { test, expect } from "@playwright/test";
test("admin notification controls save nonsecret settings, preserve errors and confirm tests", async ({
  page,
}) => {
  const user = {
    id: "synthetic-admin",
    displayName: "Synthetic Admin",
    email: null,
    roles: ["super_admin"],
    accessStatus: "active",
  };
  let settings = {
    enabled: false,
    from: "BizTech Expense Reports <Notifications@trustbiztech.com>",
    reviewUrl: "http://192.168.203.180:3001/",
    recipient: "Office@trustbiztech.com",
    testRecipient: "alex@trustbiztech.com",
    keyConfigured: false,
    deliveryApproved: false,
    counts: [],
  };
  let fail = false,
    writes = 0,
    tests = 0;
  let failTest = false;
  const testIds: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({ json: { authenticated: true, user } });
    if (path === "/api/admin/access")
      return route.fulfill({ json: { requests: [] } });
    if (path === "/api/admin/users")
      return route.fulfill({ json: { users: [user] } });
    if (path === "/api/admin/audit")
      return route.fulfill({
        json: { events: [], total: 0, page: 1, pageSize: 25, totalPages: 1 },
      });
    if (path === "/api/admin/notifications") {
      if (route.request().method() === "POST") {
        writes++;
        const body = route.request().postDataJSON();
        expect(JSON.stringify(body)).not.toContain("API_KEY");
        if (body.action === "save")
          expect(body.settings.recipient).toBe("Office@trustbiztech.com");
        if (fail)
          return route.fulfill({
            status: 400,
            json: { error: "Synthetic notification save failure" },
          });
        if (body.action === "save")
          settings = { ...settings, ...body.settings };
        if (body.action === "test") {
          testIds.push(body.requestId);
          expect(body.requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          if (failTest)
            return route.fulfill({
              status: 500,
              json: { error: "Synthetic ambiguous test failure" },
            });
          tests++;
        }
      }
      return route.fulfill({ json: settings });
    }
    return route.fulfill({
      status: 404,
      json: { error: "synthetic unsupported route" },
    });
  });
  await page.goto("/");
  if (new URL(page.url()).hostname === "expense-http.test") {
    expect(
      await page.evaluate(() => ({
        secure: window.isSecureContext,
        uuid: typeof crypto.randomUUID,
        random: typeof crypto.getRandomValues,
      })),
    ).toEqual({ secure: false, uuid: "undefined", random: "function" });
  }
  const panel = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Email notifications",
      exact: true,
    }),
  });
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(
    panel.getByRole("button", { name: "Send test email" }),
  ).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel
    .getByRole("button", { name: "Save notification settings" })
    .click();
  await expect(panel.getByRole("status")).toContainText("saved");
  expect(writes).toBe(1);
  await page.reload();
  await expect(panel.getByRole("checkbox")).toBeChecked();
  fail = true;
  await panel
    .getByRole("button", { name: "Save notification settings" })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "Synthetic notification save failure",
  );
  fail = false;
  settings.keyConfigured = true;
  settings.deliveryApproved = true;
  await panel.getByRole("button", { name: "Refresh delivery status" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel.getByRole("button", { name: "Send test email" }).click();
  expect(tests).toBe(0);
  expect(testIds).toHaveLength(0);
  failTest = true;
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Send test email" }).click();
  await expect(panel.getByRole("status")).toContainText(
    "Synthetic ambiguous test failure",
  );
  expect(testIds).toHaveLength(1);
  failTest = false;
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Send test email" }).click();
  await expect.poll(() => tests).toBe(1);
  expect(testIds).toHaveLength(2);
  expect(testIds[1]).toBe(testIds[0]);
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Send test email" }).click();
  await expect.poll(() => tests).toBe(2);
  expect(testIds[2]).not.toBe(testIds[1]);
  await expect(panel.getByLabel("Recipient", { exact: true })).toHaveValue(
    "Office@trustbiztech.com",
  );
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await panel.screenshot({ path: "test-results/notification-admin-dark.png" });
  await page.screenshot({
    path: "test-results/notification-admin.png",
    fullPage: true,
  });
});
