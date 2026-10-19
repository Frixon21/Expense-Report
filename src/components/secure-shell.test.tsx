// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SecureShell from "./secure-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockPendingUser(available: boolean) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return new Response(JSON.stringify({
        authenticated: true,
        user: { id: "pending-user", displayName: "Synthetic Employee", email: "employee@example.test", accessStatus: "pending", roles: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/admin/bootstrap/availability") {
      return new Response(JSON.stringify({ available }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected synthetic request: " + url);
  });
}

describe("pending first-admin bootstrap UI", () => {
  it("does not render a token form when server state says an active admin exists", async () => {
    mockPendingUser(false);
    render(<SecureShell />);

    expect(await screen.findByText(/first-admin setup is unavailable/i)).toBeVisible();
    expect(screen.queryByLabelText("One-time first-admin bootstrap token")).not.toBeInTheDocument();
    expect(screen.getByText(/a super admin must approve your request/i)).toBeVisible();
  });

  it("renders the one-time form only when the server says bootstrap is available", async () => {
    mockPendingUser(true);
    render(<SecureShell />);

    expect(await screen.findByLabelText("One-time first-admin bootstrap token")).toBeVisible();
    expect(screen.getByRole("button", { name: "Bootstrap first admin" })).toBeDisabled();
  });
});

it("renders one authenticated header across employee modules and keeps profile settings accessible", async () => {
  const user = { id: "employee", displayName: "Synthetic Account", email: "employee@example.test", roles: ["employee"], accessStatus: "active" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input) === "/api/auth/me" ? { authenticated: true, user } : {
    user, state: { version: 1, profile: { driverName: "Synthetic Driver", businessName: "Biztech", vehicleDescription: "Synthetic Car", businessUseStartDate: "2026-01-01" }, trips: [], annualMileage: [] }, expenses: [], history: [],
  }), { headers: { "content-type": "application/json" } }));
  render(<SecureShell />);
  await screen.findByRole("heading", { name: "Mileage log" });
  expect(document.querySelectorAll("header.topbar")).toHaveLength(1);
  expect(document.querySelectorAll("a.brand")).toHaveLength(1);
  expect(screen.getByText("Synthetic Driver · Synthetic Car")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  fireEvent.click(screen.getByRole("tab", { name: "Expenses" }));
  expect(document.querySelectorAll("header.topbar")).toHaveLength(1);
  expect(document.querySelectorAll("a.brand")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Payroll" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
});
