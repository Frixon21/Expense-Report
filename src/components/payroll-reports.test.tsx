// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PayrollReports from "./payroll-reports";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const employee = (id: number) => ({ id: String(id), displayName: "Employee " + id, reportName: "Employee " + id, email: "synthetic@example.test", tripCount: id ? 1 : 0, expenseCount: 0, recordCount: id ? 1 : 0, canExport: Boolean(id), unavailableReason: id ? null : "No records in the selected dates.", filename: "Employee_" + id + "_2026-10-10_to_2026-10-23.pdf" });
const payload = (page = 1) => ({ from: "2026-10-10", to: "2026-10-23", employees: Array.from({ length: 10 }, (_, i) => employee((page - 1) * 10 + i)), page, pageSize: 10, total: 100, totalPages: 10, totalEmployees: 100, employeesWithRecords: 99, exportableEmployees: 99 });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

it("starts collapsed, bounds rows, explains empty exports, and sends pagination/search/filter requests", async () => {
  const fetcher = vi.fn(async (input: string) => response(payload(Number(new URL(input, "http://localhost").searchParams.get("page")))));
  vi.stubGlobal("fetch", fetcher);
  render(<PayrollReports from="2026-10-10" to="2026-10-23" revision={0} />);
  await screen.findByText("100");
  expect(document.querySelector("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("Employee reports"));
  expect(document.querySelectorAll("li")).toHaveLength(10);
  expect(screen.getByRole("button", { name: "Payroll PDF for Employee 0" })).toBeDisabled();
  expect(screen.getByText("No records in the selected dates.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText(/Page 2 of 10/);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Alex" } });
  await waitFor(() => expect(String(fetcher.mock.lastCall?.[0])).toContain("q=Alex"));
  expect(String(fetcher.mock.lastCall?.[0])).toContain("page=1");
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(String(fetcher.mock.lastCall?.[0])).toContain("withRecords=true"));
});

it("immediately removes stale export controls on date changes and ignores late old results", async () => {
  const pending: Array<(value: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))));
  const view = render(<PayrollReports from="2026-10-10" to="2026-10-23" revision={0} />);
  pending[0]!(response(payload()));
  await screen.findByText("100");
  fireEvent.click(screen.getByText("Employee reports"));
  view.rerender(<PayrollReports from="2026-10-24" to="2026-11-06" revision={0} />);
  expect(screen.queryByRole("button", { name: /Payroll PDF for/ })).toBeNull();
  view.rerender(<PayrollReports from="2026-11-07" to="2026-11-20" revision={0} />);
  pending[1]!(response(payload()));
  await waitFor(() => expect(screen.getByText("Checking employee records for these dates...")).toBeVisible());
  expect(screen.queryByRole("button", { name: /Payroll PDF for/ })).toBeNull();
  pending[2]!(new Response(JSON.stringify({ error: "Synthetic outage" }), { status: 503 }));
  await screen.findByText("Synthetic outage");
  expect(screen.queryByRole("button", { name: /Payroll PDF for/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry availability" }));
  await waitFor(() => expect(pending).toHaveLength(4));
});

it("keeps a two-employee list free of redundant dates, counts, and pagination", async () => {
  vi.stubGlobal("fetch", async () => response({ ...payload(), employees: [employee(0), employee(1)], total: 2, totalPages: 1, totalEmployees: 2 }));
  render(<PayrollReports from="2026-10-10" to="2026-10-23" revision={0} />);
  fireEvent.click(screen.getByRole("button", { name: /Employee reports/ }));
  await screen.findByRole("button", { name: "Payroll PDF for Employee 1" });
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByText(/Showing|ready to export|2026-10-10/)).toBeNull();
  expect(screen.getByRole("button", { name: "Payroll PDF for Employee 0" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Employee reports/ }));
  expect(screen.getByRole("button", { name: /Employee reports/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("searchbox")).toBeVisible();
});
