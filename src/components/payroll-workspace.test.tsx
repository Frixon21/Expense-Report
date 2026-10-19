// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import PayrollWorkspace from "./payroll-workspace";

const data = {
  employees: [{ id: "employee-1", displayName: "Synthetic Employee", email: "employee@example.test", profile: null }],
  rates: [{ id: "rate-1", effective_from: "2026-01-01", cents_per_mile: 70, created_at: "2026-01-01T00:00:00.000Z" }],
  trips: [{
    id: "trip-1", ownerId: "employee-1", ownerName: "Synthetic Employee", date: "2026-10-06",
    destination: "Synthetic Office", businessPurpose: "Demo travel", start_tenths: 100, end_tenths: 400,
    status: "Processed" as const, everProcessed: true, processedBy: "Synthetic Payroll", paidBy: null,
    reimbursementCents: 2100, rateCentsPerMile: 70,
  }],
  expenses: [{
    id: "expense-1", ownerId: "employee-1", ownerName: "Synthetic Employee", date: "2026-10-07",
    category: "supplies", amount: 1500, paymentMethod: "personal_card", merchant: "Synthetic Store",
    businessPurpose: "Demo supplies", status: "Submitted" as const, everProcessed: false,
    processedBy: null, paidBy: null, reimbursableCents: 1500,
  }],
  history: [{ id: "history-1", recordId: "trip-1", actorName: "Synthetic Payroll", action: "processed", reason: null, createdAt: "2026-10-19T12:00:00.000Z" }],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00"));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "/api/payroll") return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ employees: [], total: 0, totalEmployees: 0, totalPages: 1, page: 1, pageSize: 10 }));
  });
});

it("offers only the selected mileage inputs, previews distance, and sends a consistent total-mile repair", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return new Response("{}"); }
    return new Response(JSON.stringify(String(input) === "/api/payroll" ? data : { employees: [], total: 0, totalEmployees: 0, totalPages: 1 }));
  });
  render(<PayrollWorkspace isAdmin />);
  await screen.findByRole("heading", { name: "Payroll" });
  const row = Array.from(document.querySelectorAll(".payroll-records-table tbody tr")).find((row) => row.textContent?.includes("Synthetic Office"))!;
  fireEvent.click(within(row as HTMLElement).getByText("Actions"));
  fireEvent.click(within(row as HTMLElement).getByText("Audited repair"));
  expect(screen.getByLabelText("Total miles")).toHaveValue("30");
  expect(screen.queryByLabelText("Odometer start")).toBeNull();
  expect(screen.queryByLabelText("Corrected date")).toBeNull();
  fireEvent.change(screen.getByLabelText("Mileage entry"), { target: { value: "odometer" } });
  expect(screen.getByLabelText("Odometer start")).toHaveValue("10");
  expect(screen.getByLabelText("Odometer end")).toHaveValue("40");
  expect(screen.queryByLabelText("Total miles")).toBeNull();
  fireEvent.change(screen.getByLabelText("Odometer end"), { target: { value: "5" } });
  expect(screen.getByText("Check readings")).toBeVisible();
  fireEvent.change(within(row as HTMLElement).getByLabelText("Repair reason"), { target: { value: "Synthetic correction" } });
  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Save repair" }));
  expect(writes).toHaveLength(0);
  expect(screen.getByRole("alert")).toHaveTextContent("end must be at least start");
  fireEvent.change(screen.getByLabelText("Mileage entry"), { target: { value: "total" } });
  fireEvent.change(screen.getByLabelText("Total miles"), { target: { value: "45.5" } });
  expect(screen.getByText("45.5 mi")).toBeVisible();
  fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Save repair" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ type: "trip", id: "trip-1", reason: "Synthetic correction", patch: { start_tenths: 100, end_tenths: 555 } });
});

it("shows one persistent dismissible alert and a local rate error without submitting", async () => {
  render(<PayrollWorkspace isAdmin={false} />);
  await screen.findByRole("heading", { name: "Payroll" });
  const row = Array.from(document.querySelectorAll(".payroll-records-table tbody tr")).find((row) => row.textContent?.includes("Synthetic Office"))!;
  fireEvent.click(within(row as HTMLElement).getByText("Actions"));
  fireEvent.click(within(row as HTMLElement).getByText("Audited repair"));
  if (!(row.querySelector(".repair-rate-details") as HTMLDetailsElement).open) fireEvent.click(within(row as HTMLElement).getByText("Rate correction"));
  fireEvent.click(screen.getByRole("button", { name: "Audited rate correction" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a reason for the rate correction.");
  expect(document.querySelector(".action-field-error")).toHaveTextContent("Enter a reason");
  expect(document.querySelector(".global-message")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss notification" }), { key: "Escape" });
  expect(screen.queryByRole("alert")).toBeNull();
  if (!(row.querySelector(".repair-rate-details") as HTMLDetailsElement).open) fireEvent.click(within(row as HTMLElement).getByText("Rate correction"));
  fireEvent.click(screen.getByRole("button", { name: "Audited rate correction" }));
  fireEvent.change(screen.getByLabelText("Reason for reversal, void, or rate correction"), { target: { value: "Synthetic correction" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("payroll record workspace", () => {
  it("uses configured current and previous biweekly report periods", async () => {
    render(<PayrollWorkspace isAdmin={false} />);
    await screen.findByRole("heading", { name: "Payroll" });
    const reportInputs = document.querySelectorAll(".payroll-report-range input");

    fireEvent.click(screen.getByRole("button", { name: "Current pay period" }));
    expect(Array.from(reportInputs).map((input) => (input as HTMLInputElement).value)).toEqual(["2026-10-10", "2026-10-23"]);
    expect(screen.getByText("Payday: 2026-10-30.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous pay period" }));
    expect(Array.from(reportInputs).map((input) => (input as HTMLInputElement).value)).toEqual(["2026-09-26", "2026-10-09"]);
    expect(screen.getByText("Payday: 2026-10-16.")).toBeVisible();
  });

  it("filters by employee, status, type and date, and keeps payroll rate correction in its disclosure", async () => {
    render(<PayrollWorkspace isAdmin={false} />);
    await screen.findByRole("heading", { name: "Payroll" });
    const filters = document.querySelector(".payroll-record-filters")! as HTMLElement;
    const selects = within(filters).getAllByRole("combobox");

    expect(document.querySelectorAll(".payroll-records-table tbody tr")).toHaveLength(2);
    fireEvent.change(selects[0]!, { target: { value: "employee-1" } });
    fireEvent.change(selects[1]!, { target: { value: "Processed" } });
    fireEvent.change(selects[2]!, { target: { value: "trip" } });
    fireEvent.change(within(filters).getByLabelText("From"), { target: { value: "2026-10-05" } });
    fireEvent.change(within(filters).getByLabelText("To"), { target: { value: "2026-10-08" } });

    expect(document.querySelectorAll(".payroll-records-table tbody tr")).toHaveLength(1);
    expect(screen.getByText(/Synthetic Office/)).toBeVisible();

    const row = Array.from(document.querySelectorAll(".payroll-records-table tbody tr")).find((row) => row.textContent?.includes("Synthetic Office"))! as HTMLElement;
    const actions = row.querySelector(".payroll-record-controls")! as HTMLElement;
    fireEvent.click(within(actions).getByText("Actions"));
    const repair = within(actions).getByText("Audited repair");
    fireEvent.click(repair);
    fireEvent.click(within(actions).getByText("Rate correction"));
    expect(within(actions).getByLabelText("Corrected $/mi")).toBeVisible();
    expect(within(actions).getByRole("button", { name: "Audited rate correction" })).toBeVisible();
    expect(within(actions).queryByLabelText("Corrected date")).not.toBeInTheDocument();
  });
});
