import { expect, test, type Page } from "@playwright/test";
const alice = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Synthetic Alice",
  email: "alice@example.test",
  roles: ["employee"],
  accessStatus: "active",
};
const bob = {
  ...alice,
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "Synthetic Bob",
};
const day = new Date().toLocaleDateString("en-CA");
const original = {
  id: "33333333-3333-4333-8333-333333333333",
  createdAt: new Date().toISOString(),
  date: day,
  category: "meals",
  amount: 1234,
  paymentMethod: "personal_card",
  merchant: "Synthetic Cafe",
  businessPurpose: "Synthetic meeting",
  status: "Paid",
  everProcessed: true,
};
const trip = {
  id: "44444444-4444-4444-8444-444444444444",
  createdAt: new Date().toISOString(),
  date: day,
  destination: "Synthetic office",
  businessPurpose: "Synthetic service",
  start_tenths: 1000,
  end_tenths: 1100,
  parking_cents: 100,
  tolls_cents: 0,
  status: "Paid",
};
async function fixture(page: Page, initialUser = alice) {
  let user = initialUser,
    signedIn = true;
  let expenses = initialUser.id === alice.id ? [{ ...original }] : [],
    trips = initialUser.id === alice.id ? [{ ...trip }] : [];
  let posts = 0;
  const state = () => ({
    version: 1,
    profile: {
      driverName: user.displayName,
      businessName: "Biztech",
      vehicleDescription: "Synthetic car",
      businessUseStartDate: "2026-01-01",
    },
    annualMileage: [],
    trips,
  });
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/me")
      return route.fulfill({
        json: signedIn
          ? { authenticated: true, user }
          : { authenticated: false },
      });
    if (pathname === "/api/auth/logout") {
      signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === "/api/auth/login") {
      signedIn = true;
      user = bob;
      return route.fulfill({ json: { user } });
    }
    if (pathname === "/api/me") {
      if (route.request().method() === "POST") {
        posts++;
        const data = route.request().postDataJSON();
        expenses = data.expenses;
        trips = data.state.trips;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return route.fulfill({
        json: {
          user,
          state: state(),
          expenses,
          history:
            user.id === alice.id
              ? [
                  {
                    id: "event-paid",
                    recordType: "expense",
                    recordId: original.id,
                    action: "mark_paid",
                    fromStatus: "Processed",
                    toStatus: "Paid",
                    createdAt: "2026-10-26T13:00:00.000Z",
                    actorName: "Synthetic payroll",
                    reason: null,
                  },
                  {
                    id: "event-void",
                    recordType: "trip",
                    recordId: trip.id,
                    action: "void",
                    fromStatus: "Submitted",
                    toStatus: "Voided",
                    createdAt: "2026-10-26T12:00:00.000Z",
                    actorName: "Synthetic payroll",
                    reason: "Synthetic duplicate rejected",
                  },
                ]
              : [],
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "No synthetic endpoint" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "Expenses", exact: true }),
  ).toBeVisible();
  return { posts: () => posts, expenses: () => expenses, trips: () => trips };
}
test("appearance persists, system follows preference, and printing stays light", async ({
  page,
}) => {
  await fixture(page);
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await expect(page.locator(".panel").first()).toHaveCSS(
    "background-color",
    "rgb(26, 38, 56)",
  );
  const row = page.locator(".trip-row").first();
  const amount = await row.locator(".trip-miles").boundingBox();
  const actions = await row.locator(".row-actions").boundingBox();
  expect(actions!.x).toBeGreaterThanOrEqual(amount!.x + amount!.width);
  await page.screenshot({ path: "test-results/qol-dark.png", fullPage: true });
  await page.emulateMedia({ media: "print" });
  expect(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(255, 255, 255)");
  await expect(page.getByLabel("Theme", { exact: true })).toBeHidden();
  await page.emulateMedia({ media: "screen", colorScheme: "dark" });
  await page.getByLabel("Theme", { exact: true }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
test("duplicate expense and mileage require new values and confirmation, cancel safely, save once", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate Synthetic Cafe", exact: true })
    .click();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Cancel duplicate" }).click();
  expect(f.posts()).toBe(0);
  await page
    .getByRole("button", { name: "Duplicate Synthetic Cafe", exact: true })
    .click();
  await page.getByLabel("Amount", { exact: true }).fill("7.50");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await expect(page.locator("p[role=alert]")).toContainText(
    "Confirm the new date and amount",
  );
  expect(f.posts()).toBe(0);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Save expense", exact: true })
    .dblclick();
  await expect(
    page.getByRole("status").filter({ hasText: "Expense saved" }),
  ).toBeVisible();
  expect(f.posts()).toBe(1);
  const copy = f.expenses().find((e) => e.id !== original.id)!;
  expect(copy.amount).toBe(750);
  expect(copy.status).toBeUndefined();
  expect(copy.everProcessed).toBeUndefined();
  await page.getByRole("tab", { name: "Mileage", exact: true }).click();
  await page
    .getByRole("button", { name: "Duplicate Synthetic service", exact: true })
    .click();
  await expect(page.getByLabel("Odometer end", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Parking", { exact: false })).toHaveValue("");
  await page.getByLabel("Odometer end", { exact: true }).fill("120");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save trip", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Trip saved" }),
  ).toBeVisible();
  expect(f.trips().find((t) => t.id !== trip.id)?.status).toBeUndefined();
});
test("draft refresh and back recovery, discard, remembered choices, and logout isolate users", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("shipping");
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Private synthetic draft");
  await page.getByLabel("Amount", { exact: true }).fill("9.25");
  await page
    .getByLabel("Business purpose", { exact: true })
    .fill("Synthetic draft test");
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Recover draft" }).click();
  await expect(
    page.getByLabel("Merchant or description", { exact: true }),
  ).toHaveValue("Private synthetic draft");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Expense saved" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Category", exact: true }),
  ).toHaveValue("shipping");
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("");
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Discard me");
  await page.goto("/preview");
  await page.goBack();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover draft" })).toHaveCount(
    0,
  );
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Alice only");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.endsWith(":draft")),
    ),
  ).toEqual([]);
  await page.getByLabel("BT Auth username").fill("bob");
  await page.getByLabel("Password", { exact: true }).fill("synthetic");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover draft" })).toHaveCount(
    0,
  );
  await expect(
    page.getByLabel("Merchant or description", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Category", exact: true }),
  ).toHaveValue("supplies");
  await expect(
    page.getByText("Synthetic duplicate rejected", { exact: false }),
  ).toHaveCount(0);
  expect(f.posts()).toBe(1);
});
test("receipt corruption is rejected; thumbnail and saved rotation survive reload", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  const file = page.locator('input[type="file"]');
  for (const mimeType of ["image/png", "application/pdf", "text/plain"]) {
    await file.setInputFiles({
      name: mimeType === "application/pdf" ? "broken.pdf" : "broken.png",
      mimeType,
      buffer: Buffer.from("not a receipt"),
    });
    await expect(page.locator("p[role=alert]")).toContainText(
      /Unreadable|readable/,
    );
  }
  await file.setInputFiles({
    name: "empty.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(0),
  });
  await expect(page.locator("p[role=alert]")).toContainText("empty");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 20;
    const x = c.getContext("2d")!;
    x.fillStyle = "green";
    x.fillRect(0, 0, 40, 20);
    return c.toDataURL("image/png");
  });
  await file.setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(data.split(",")[1], "base64"),
  });
  await expect(page.getByAltText("Receipt thumbnail")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Rotate attachment", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rotate attachment", exact: true }),
  ).toBeEnabled();
  const rotated = await page
    .getByAltText("Receipt thumbnail")
    .getAttribute("src");
  expect(rotated).not.toBe(data);
  await page.getByLabel("Amount", { exact: true }).fill("3");
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Rotation test");
  await page.getByLabel("Business purpose", { exact: true }).fill("Synthetic");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Expense saved" }),
  ).toBeVisible();
  expect(
    (
      f.expenses().find((e) => e.id !== original.id) as unknown as {
        receiptDataUrl: string;
      }
    ).receiptDataUrl,
  ).toBe(rotated);
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByRole("button", { name: "View: synthetic.png", exact: true })
    .click();
  await page.getByRole("button", { name: "Rotate view", exact: true }).click();
  await expect(page.locator(".receipt-viewer-image")).toHaveCSS(
    "transform",
    /matrix/,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Your record history")).toContainText(
    "Processed to Paid",
  );
  await expect(page.getByLabel("Your record history")).toContainText(
    "Synthetic duplicate rejected",
  );
  await page.screenshot({
    path: "test-results/qol-expenses.png",
    fullPage: true,
  });
});

test("editing drafts recover only while the source record remains editable", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Editable synthetic");
  await page.getByLabel("Business purpose", { exact: true }).fill("Synthetic");
  await page.getByRole("button", { name: "Save expense", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Expense saved" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit Editable synthetic", exact: true })
    .click();
  await page.getByLabel("Amount", { exact: true }).fill("4");
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Recover draft" }).click();
  await expect(
    page.getByRole("button", { name: "Update expense", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("4");
  await page.getByLabel("Amount", { exact: true }).fill("5");
  f.expenses().find((e) => e.id !== original.id)!.status = "Paid";
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.getByRole("button", { name: "Recover draft" }).click();
  await expect(
    page.getByText("This record was deleted or locked by payroll.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update expense", exact: true }),
  ).toHaveCount(0);
  expect(f.posts()).toBe(1);
  await page.getByRole("button", { name: "Discard draft" }).click();
});

test("blocked draft storage warns while keeping form input usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Synthetic blocked storage", "QuotaExceededError");
    };
  });
  await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Still here");
  await expect(
    page.getByText(
      "Your unfinished entry could not be saved on this browser.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Merchant or description", { exact: true }),
  ).toHaveValue("Still here");
});

test("valid PDF upload and download retain the synthetic file", async ({
  page,
}) => {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 100]);
  await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  });
  await page
    .getByRole("button", { name: "View: synthetic.pdf", exact: true })
    .click();
  await expect(page.locator(".receipt-viewer-frame")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rotate view", exact: true }),
  ).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("synthetic.pdf");
  await page
    .getByRole("button", { name: "Close receipt viewer", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing a page retains Alice's draft while another account cannot recover it", async ({
  page,
  context,
}) => {
  await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Alice private unfinished");
  await page.close();
  const reopened = await context.newPage();
  await fixture(reopened);
  await reopened.getByRole("tab", { name: "Expenses", exact: true }).click();
  await reopened.getByRole("button", { name: "Recover draft" }).click();
  await expect(
    reopened.getByLabel("Merchant or description", { exact: true }),
  ).toHaveValue("Alice private unfinished");
  const other = await context.newPage();
  await fixture(other, bob);
  await other.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "Recover draft" }),
  ).toHaveCount(0);
  await expect(
    other.getByLabel("Merchant or description", { exact: true }),
  ).toHaveValue("");
  await expect(other.getByLabel("Your record history")).not.toContainText(
    "Synthetic payroll",
  );
});

test("expired drafts are ignored and the real unauthenticated production health route responds", async ({
  page,
  request,
}) => {
  await fixture(page);
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await page
    .getByLabel("Merchant or description", { exact: true })
    .fill("Expired synthetic");
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) =>
      k.endsWith(":expense:draft"),
    )!;
    const draft = JSON.parse(localStorage.getItem(key)!);
    draft.savedAt = Date.now() - 31 * 86400000;
    localStorage.setItem(key, JSON.stringify(draft));
  });
  await page.reload();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover draft" })).toHaveCount(
    0,
  );
  const response = await request.get("/api/auth/me");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ authenticated: false });
});

test("dark hover controls use soft blue with readable focus, while light styling stays intact", async ({
  page,
}) => {
  await fixture(page);
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(
    page.getByText("Unfinished form text is saved on this browser", {
      exact: false,
    }),
  ).toHaveCount(0);
  const selected = page.getByRole("tab", { name: "Mileage", exact: true });
  await selected.hover();
  await expect(selected).toHaveCSS("background-color", "rgb(40, 95, 174)");
  await expect(selected).toHaveCSS("color", "rgb(255, 255, 255)");
  const targets = [
    page.getByRole("button", { name: "Save trip", exact: true }),
    page.getByRole("tab", { name: "Expenses", exact: true }),
    page.getByRole("button", {
      name: "Duplicate Synthetic service",
      exact: true,
    }),
    page.getByRole("button", { name: "Today", exact: true }),
  ];
  for (const [index, button] of targets.entries()) {
    await button.hover();
    await expect(selected).toHaveCSS("background-color", "rgb(40, 95, 174)");
    await expect(button).toHaveCSS("background-color", "rgb(155, 179, 209)");
    await expect(button).toHaveCSS("color", "rgb(23, 36, 58)");
    await page.screenshot({
      path: `test-results/qol-hover-${index}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: "Duplicate Synthetic service", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "I confirm the new date, distance and costs are accurate.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Reimbursement uses the applicable payroll rate.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Cancel duplicate", exact: true })
    .click();
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  const file = page.locator('input[type="file"]');
  expect(
    await file.evaluate(
      (el) => getComputedStyle(el, "::file-selector-button").backgroundColor,
    ),
  ).toBe("rgb(40, 95, 174)");
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 10;
    canvas.height = 10;
    return canvas.toDataURL("image/png");
  });
  await file.setInputFiles({
    name: "hover-synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(data.split(",")[1], "base64"),
  });
  const view = page.getByRole("button", {
    name: "View: hover-synthetic.png",
    exact: true,
  });
  await view.hover();
  await expect(view).toHaveCSS("background-color", "rgb(155, 179, 209)");
  await expect(view).toHaveCSS("color", "rgb(23, 36, 58)");
  await page.screenshot({
    path: "test-results/qol-hover-receipt.png",
    fullPage: true,
  });
  const theme = page.getByLabel("Theme", { exact: true });
  await theme.focus();
  await expect(theme).toHaveCSS("outline-color", "rgb(143, 189, 255)");
  await page.screenshot({
    path: "test-results/qol-focus-header.png",
    fullPage: true,
  });
  await theme.selectOption("light");
  const save = page.getByRole("button", { name: "Save expense", exact: true });
  await save.hover();
  await expect(save).toHaveCSS("background-color", "rgb(23, 61, 120)");
});

test("theme shares one existing header with navigation and account controls at wrapped widths", async ({
  page,
}) => {
  await fixture(page);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const header = page.locator("header.topbar");
    await expect(header).toHaveCount(1);
    await expect(header.getByLabel("Theme", { exact: true })).toHaveCount(1);
    await expect(page.locator("body > .theme-picker")).toHaveCount(0);
    await expect(
      header.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("tab", { name: "Mileage", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("tab", { name: "Expenses", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/qol-header-${width}.png`,
      fullPage: true,
    });
  }
});
