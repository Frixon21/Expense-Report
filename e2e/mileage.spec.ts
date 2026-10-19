import { test, expect, type Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/preview");
  await expect(page.getByRole("button", { name: "Save trip" })).toBeVisible();
}
test("mobile mileage records persist across reload and can be edited and deleted", async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel("Destination or area").fill("Sacramento client office");
  await page.getByLabel("Business purpose").fill("Network installation");
  await page.getByLabel("Odometer start").fill("100.1");
  await page.getByLabel("Odometer end").fill("125.4");
  await page.getByLabel(/Parking/).fill("8.50");
  await expect(page.getByTestId("calculated-miles")).toContainText("25.3");
  await page.getByRole("button", { name: "Save trip" }).click();
  await page.reload();
  await expect(page.getByText("Network installation")).toBeVisible();
  await page.getByRole("button", { name: /Edit Network installation/ }).click();
  await page.getByLabel("Business purpose").fill("Equipment delivery");
  await page.getByRole("button", { name: "Update trip" }).click();
  await expect(page.getByText("Equipment delivery")).toBeVisible();
  await page.getByRole("button", { name: /Delete Equipment delivery/ }).click();
  await page.getByRole("button", { name: "Delete trip", exact: true }).click();
  await expect(page.getByText("Equipment delivery")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("final report requires annual odometer readings and backup downloads", async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel("Destination or area").fill("Oakland");
  await page.getByLabel("Business purpose").fill("Client meeting");
  await page.getByLabel("Odometer start").fill("10000");
  await page.getByLabel("Odometer end").fill("10020");
  await page.getByRole("button", { name: "Save trip" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-01-01");
  await page.getByLabel("To", { exact: true }).fill("2026-12-31");
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(
    page.getByText(/before creating the final tax-year report/),
  ).toBeVisible();
  await page.getByLabel("Opening odometer").fill("9000");
  await page.getByLabel("Closing/current odometer").fill("12000");
  await page.getByRole("button", { name: "Save annual mileage" }).click();
  const backup = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  expect((await backup).suggestedFilename()).toMatch(/\.json$/);
});

test("payroll date controls stay grouped without excess vertical space", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/preview");
  await page.getByRole("tab", { name: "Payroll" }).click();

  const heading = page.getByRole("heading", { name: "Custom date range" });
  const from = page.getByLabel("From", { exact: true });
  const quickFilters = page.getByRole("heading", { name: "Quick filters" });
  const headingBox = await heading.boundingBox();
  const fromBox = await from.boundingBox();
  const quickFiltersBox = await quickFilters.boundingBox();

  expect(headingBox).not.toBeNull();
  expect(fromBox).not.toBeNull();
  expect(quickFiltersBox).not.toBeNull();
  expect(fromBox!.y - (headingBox!.y + headingBox!.height)).toBeLessThan(64);
  expect(quickFiltersBox!.y - headingBox!.y).toBeLessThan(180);
});
