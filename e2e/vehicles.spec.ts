import { expect, test, type Page } from "@playwright/test";
const car = "11111111-1111-4111-8111-111111111111",
  car2 = "22222222-2222-4222-8222-222222222222";
const day = new Date().toLocaleDateString("en-CA");
async function setup(page: Page) {
  const user = {
    id: "vehicle-test-alice",
    displayName: "Synthetic Alice",
    roles: ["employee"],
    accessStatus: "active",
    email: null,
  };
  let state = {
    version: 1,
    profile: {
      driverName: "Synthetic Alice",
      businessName: "Synthetic",
      vehicleDescription: "Original car",
      businessUseStartDate: "2026-01-01",
    },
    vehicles: [
      {
        id: car,
        description: "Original car",
        businessUseStartDate: "2026-01-01",
        retired: false,
      },
      {
        id: car2,
        description: "Second car",
        businessUseStartDate: "2026-02-01",
        retired: false,
      },
    ],
    defaultVehicleId: car,
    annualMileage: [
      {
        vehicleId: car,
        year: Number(day.slice(0, 4)),
        opening_tenths: 1000,
        closing_tenths: 2000,
      },
      {
        vehicleId: car2,
        year: Number(day.slice(0, 4)),
        opening_tenths: 9000,
        closing_tenths: 10000,
      },
    ],
    trips: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        date: day,
        destination: "Original office",
        businessPurpose: "Original visit",
        start_tenths: 1000,
        end_tenths: 1100,
        parking_cents: 0,
        tolls_cents: 0,
        vehicleId: car,
        vehicleName: "Original car",
        createdAt: new Date().toISOString(),
        status: "Submitted",
      },
    ],
  };
  let posts = 0;
  let fail = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({ json: { authenticated: true, user } });
    if (path === "/api/me") {
      if (route.request().method() === "POST") {
        posts++;
        if (fail)
          return route.fulfill({
            status: 500,
            json: { error: "Synthetic save failed" },
          });
        state = route.request().postDataJSON().state;
      }
      return route.fulfill({
        json: { user, state, expenses: [], history: [] },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "Synthetic endpoint" },
    });
  });
  await page.goto("/");
  await expect(page.getByLabel("Trip vehicle")).toHaveValue(car);
  return {
    state: () => state,
    posts: () => posts,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
test("vehicle switching keeps odometers separate, duplicates require review, draft retains selected vehicle", async ({
  page,
}) => {
  const f = await setup(page);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "110",
  );
  await page.getByLabel("Trip vehicle").selectOption(car2);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "900",
  );
  await expect(page.getByLabel("Odometer end", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Destination or area").fill("Second office");
  await page.getByLabel("Business purpose").fill("Second vehicle visit");
  await page.getByLabel("Odometer end", { exact: true }).fill("910");
  await page.reload();
  await page.getByRole("button", { name: "Recover draft" }).click();
  await expect(page.getByLabel("Trip vehicle")).toHaveValue(car2);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "900",
  );
  await page.getByRole("button", { name: "Save trip", exact: true }).dblclick();
  await expect.poll(() => f.state().trips.length).toBe(2);
  expect(f.posts()).toBe(1);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "910",
  );
  await page.getByLabel("Trip vehicle").selectOption(car);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "110",
  );
  await page
    .getByRole("button", {
      name: "Duplicate Second vehicle visit",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Trip vehicle")).toHaveValue(car2);
  await expect(page.getByLabel("Odometer end", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Cancel duplicate" }).click();
  expect(f.posts()).toBe(1);
  await page
    .getByRole("button", { name: "Edit Original visit", exact: true })
    .click();
  await expect(page.getByLabel("Trip vehicle")).toHaveValue(car);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "100",
  );
  await page.getByRole("button", { name: "Cancel editing" }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.screenshot({
    path: "test-results/vehicles-dark.png",
    fullPage: true,
  });
});
test("adds cars, default survives reload, annual readings remain independent and failed saves stay visible", async ({
  page,
}) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByLabel("Vehicle name", { exact: true }).fill("Third car");
  await dialog
    .getByRole("button", { name: "Add vehicle", exact: true })
    .dblclick();
  await expect.poll(() => f.state().vehicles.length).toBe(3);
  expect(f.posts()).toBe(1);
  const second = dialog.locator(".trip-row").filter({ hasText: "Second car" });
  await second.getByRole("button", { name: "Make default" }).click();
  await expect.poll(() => f.state().defaultVehicleId).toBe(car2);
  await dialog.getByLabel("Annual readings vehicle").selectOption(car2);
  await expect(
    dialog.getByLabel("Opening odometer", { exact: true }),
  ).toHaveValue("900");
  await dialog.getByLabel("Annual readings vehicle").selectOption(car);
  await expect(
    dialog.getByLabel("Opening odometer", { exact: true }),
  ).toHaveValue("100");
  await dialog.getByLabel("Vehicle name", { exact: true }).fill("Will fail");
  f.fail(true);
  await dialog
    .getByRole("button", { name: "Add vehicle", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Synthetic save failed",
  );
  expect(f.state().vehicles.length).toBe(3);
  f.fail(false);
  await page.screenshot({
    path: "test-results/vehicles-settings.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await page.reload();
  await expect(page.getByLabel("Trip vehicle")).toHaveValue(car2);
  await expect(page.getByLabel("Odometer start", { exact: true })).toHaveValue(
    "900",
  );
});
