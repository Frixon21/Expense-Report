// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CLIENT_REQUEST_TIMEOUT_MS } from "@/lib/client-json";
import SecureShell from "./secure-shell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("leaves the loading screen on timeout and retries without bypassing authentication", async () => {
  vi.useFakeTimers();
  let retry = false;
  vi.stubGlobal("fetch", () => retry ? Promise.resolve(Response.json({ authenticated: false })) : new Promise(() => {}));
  render(<SecureShell />);
  expect(screen.getByRole("status")).toHaveTextContent("Checking your app session");
  await act(async () => { await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS); });
  expect(screen.getByRole("heading", { name: "Could not check your session" })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("took too long");
  expect(screen.queryByLabelText("Password")).toBeNull();
  retry = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry session check" })); });
  expect(screen.getByRole("heading", { name: "Sign in to Expense Report" })).toBeVisible();
});

it("shows retry for server failure or malformed session data instead of remaining in initialization", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "Synthetic outage" }, { status: 503 }));
  render(<SecureShell />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic outage");
  vi.stubGlobal("fetch", async () => Response.json({ authenticated: true }));
  fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("invalid response");
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

it("keeps the session visible when logout fails and clears it only after server confirmation", async () => {
  let logoutFails = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/me") return Response.json({ authenticated: true, user: { id: "pending", displayName: "Synthetic", accessStatus: "pending", roles: [] } });
    if (String(input) === "/api/auth/logout") return logoutFails ? Response.json({ error: "Synthetic logout failure" }, { status: 503 }) : Response.json({ ok: true });
    return Response.json({ available: false });
  });
  render(<SecureShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic logout failure");
  expect(screen.queryByRole("heading", { name: "Sign in to Expense Report" })).toBeNull();
  logoutFails = false;
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("heading", { name: "Sign in to Expense Report" })).toBeVisible();
});

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
