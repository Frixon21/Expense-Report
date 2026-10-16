// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DemoShell from "./demo-shell";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("demo shell", () => {
  it("carries the odometer forward through rapid consecutive mileage saves", async () => {
    render(<DemoShell />);
    await screen.findByRole("heading", { name: "Mileage log" });
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "100000" },
    });
    for (const [index, end] of [100010, 100020, 100030].entries()) {
      expect(screen.getByLabelText("Odometer start")).toHaveValue(
        String(100000 + index * 10),
      );
      fireEvent.change(screen.getByLabelText("Destination or area"), {
        target: { value: "Test office" },
      });
      fireEvent.change(screen.getByLabelText("Business purpose"), {
        target: { value: `Synthetic trip ${index + 1}` },
      });
      fireEvent.change(screen.getByLabelText("Odometer end"), {
        target: { value: String(end) },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
      expect(screen.getByLabelText("Odometer start")).toHaveValue(String(end));
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });

  it("offers Travel without transport wording in Expenses", async () => {
    render(<DemoShell />);
    await screen.findByRole("heading", { name: "Mileage log" });
    fireEvent.click(screen.getByRole("tab", { name: "Expenses" }));
    expect(screen.getByRole("option", { name: "Travel (lodging, etc.)" })).toHaveValue("travel");
    expect(screen.queryByRole("option", { name: /transport/i })).toBeNull();
  });

  it("shows employee and payroll views with multiple demo employees", async () => {
    render(<DemoShell />);
    expect(await screen.findByRole("heading", { name: "Mileage log" })).toBeTruthy();
    expect(screen.getByLabelText("Viewing as")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Payroll" }));
    expect(
      await screen.findByRole("heading", { name: "Payroll review" }),
    ).toBeTruthy();
    expect(screen.getByText("Alex Morgan")).toBeTruthy();
    expect(screen.getByText("Kevin Nguyen")).toBeTruthy();
  });
});
