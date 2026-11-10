import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

test("payroll downloads the selected employee/date PDF with its rendered receipt appendix", async ({
  page,
}) => {
  const fixture = process.env.PAYROLL_RECEIPT_PREVIEW;
  test.skip(
    !fixture,
    "Generate the isolated synthetic receipt PDF and set PAYROLL_RECEIPT_PREVIEW.",
  );
  const bytes = await readFile(fixture!);
  let downloadedBody: unknown;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: "synthetic-payroll",
            displayName: "Synthetic Payroll",
            email: null,
            roles: ["payroll"],
            accessStatus: "active",
          },
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
    if (url.pathname === "/api/reports/payroll") {
      if (route.request().method() === "POST") {
        downloadedBody = route.request().postDataJSON();
        return route.fulfill({
          contentType: "application/pdf",
          headers: {
            "Content-Disposition":
              'attachment; filename="Synthetic_alice_2026-10-01_to_2026-10-31.pdf"',
            "Cache-Control": "no-store, private",
          },
          body: bytes,
        });
      }
      return route.fulfill({
        json: {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          employees: [
            {
              id: "alice",
              displayName: "Synthetic alice",
              email: null,
              reportName: "Synthetic alice",
              tripCount: 0,
              expenseCount: 7,
              recordCount: 7,
              canExport: true,
              unavailableReason: null,
              filename: "Synthetic_alice_2026-10-01_to_2026-10-31.pdf",
            },
          ],
          page: 1,
          pageSize: 10,
          total: 1,
          totalPages: 1,
          totalEmployees: 1,
          employeesWithRecords: 1,
          exportableEmployees: 1,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "Synthetic unsupported API" },
    });
  });
  await page.goto("/");
  const reports = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Payroll reports", exact: true }),
  });
  await reports.getByLabel("From", { exact: true }).fill("2026-10-01");
  await reports.getByLabel("To", { exact: true }).fill("2026-10-31");
  await page.getByRole("button", { name: /Employee reports/ }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Payroll PDF for Synthetic alice",
      exact: true,
    })
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(
    "Synthetic_alice_2026-10-01_to_2026-10-31.pdf",
  );
  const file = await download.path();
  expect(file).toBeTruthy();
  const result = await readFile(file!);
  expect(result.equals(bytes)).toBe(true);
  expect((await PDFDocument.load(result)).getPageCount()).toBeGreaterThan(10);
  expect(downloadedBody).toEqual({
    employeeId: "alice",
    from: "2026-10-01",
    to: "2026-10-31",
  });
  await page.screenshot({
    path: "test-results/payroll-receipt-export.png",
    fullPage: true,
  });
});
