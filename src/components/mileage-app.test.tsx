// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import MileageApp from "./mileage-app";
import { createReport } from "@/lib/pdf";
vi.mock("@/lib/pdf", () => ({
  createReport: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function completeProfile() {
  fireEvent.change(screen.getByLabelText("Driver full name"), {
    target: { value: "Alex Morgan" },
  });
  fireEvent.change(screen.getByLabelText("Vehicle description"), {
    target: { value: "2023 Toyota Camry" },
  });
  fireEvent.change(screen.getByLabelText("First used for business"), {
    target: { value: "2026-01-01" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
}
describe("browser mileage log", () => {
  it("prefills trips two, three and four without overwriting manual starts", () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "100" },
    });
    for (const [index, end] of [110, 120, 130].entries()) {
      expect(screen.getByLabelText("Odometer start")).toHaveValue(String(100 + index * 10));
      fireEvent.change(screen.getByLabelText("Destination or area"), {
        target: { value: "Test office" },
      });
      fireEvent.change(screen.getByLabelText("Business purpose"), {
        target: { value: `Test trip ${index + 1}` },
      });
      fireEvent.change(screen.getByLabelText("Odometer end"), {
        target: { value: String(end) },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
      expect(screen.getByLabelText("Odometer start")).toHaveValue(String(end));
    }
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "140.5" },
    });
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByLabelText("Odometer start")).toHaveValue("140.5");
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "Earlier visit" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Backdated trip" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    expect(screen.getByLabelText("Odometer start")).toHaveValue("130");
  });

  it("shows a storage warning if browser persistence fails", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    render(<MileageApp />);
    completeProfile();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not save/i,
    );
  });

  it("requires the tax record profile and stores it in the browser", async () => {
    render(<MileageApp />);
    expect(
      await screen.findByRole("heading", { name: "Set up your mileage log" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Biztech mileage home")).toBeTruthy();
    expect(screen.queryByLabelText("Business name")).toBeNull();
    fireEvent.submit(
      screen.getByRole("button", { name: "Save profile" }).closest("form")!,
    );
    expect(screen.getByRole("alert").textContent).toContain("required");
    completeProfile();
    expect(
      await screen.findByRole("heading", { name: "Mileage log" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Biztech").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Record business travel only/i)).toBeNull();
    expect(screen.queryByText(/Recordkeeping method/i)).toBeNull();
    expect(localStorage.length).toBeGreaterThan(0);
    expect(localStorage.getItem("biztech-mileage-v1")).toContain(
      '"businessName":"Biztech"',
    );
  });
  it("requires destination and business purpose, calculates miles, and saves a trip", async () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "100.1" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "125.8" },
    });
    expect(screen.getByTestId("calculated-miles").textContent).toContain(
      "25.7",
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Save trip" }).closest("form")!,
    );
    expect(screen.getByRole("alert").textContent).toContain("Destination");
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "Sacramento client office" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Network installation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    expect(await screen.findByText("Network installation")).toBeTruthy();
  });
  it("handles inverted ranges and cancels editing", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "Fresno" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Site survey" },
    });
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    expect(screen.getByRole("alert").textContent).toMatch(/ending odometer/i);
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit Site survey/ }));
    expect(screen.getByLabelText("Odometer start")).toHaveValue("50");
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing" }));
    expect(screen.getByLabelText("Odometer start")).toHaveValue("60");
    expect(
      (screen.getByLabelText("Destination or area") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-09-01" },
    });
    expect(screen.getByText(/end date on or after/i)).toBeTruthy();
  });

  it("edits and deletes a saved trip after confirmation", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "Oakland" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Client meeting" },
    });
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit Client meeting/ }),
    );
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Equipment delivery" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update trip" }));
    expect(screen.getByLabelText("Odometer start")).toHaveValue("25");
    expect(await screen.findByText("Equipment delivery")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Delete Equipment delivery/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete trip" }));
    await waitFor(() =>
      expect(screen.queryByText("Equipment delivery")).toBeNull(),
    );
  });
  it("allows annual opening mileage now and closing mileage later", async () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Tax year"), {
      target: { value: "2026" },
    });
    fireEvent.change(screen.getByLabelText("Opening odometer"), {
      target: { value: "10000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save annual mileage" }),
    );
    expect(
      await screen.findByText(
        /Closing.*needed for the final full-year report/i,
      ),
    ).toBeTruthy();
  });
  it("validates settings edits and reports backup import errors", async () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Driver full name"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save profile changes" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/driver name/i);
    fireEvent.change(screen.getByLabelText("Driver full name"), {
      target: { value: "Alex Manager" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save profile changes" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Tax year"), {
      target: { value: "2027" },
    });
    fireEvent.change(screen.getByLabelText("Opening odometer"), {
      target: { value: "2000" },
    });
    fireEvent.change(screen.getByLabelText("Closing/current odometer"), {
      target: { value: "1000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save annual mileage" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/at least/i);
    const file = new File(["bad"], "backup.json", { type: "application/json" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/backup/i);
  });

  it("prefills the next odometer start, shows a tax-year banner, and confirms backup import", async () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "Sacramento" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Site visit" },
    });
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    await screen.findByText("Site visit");
    expect(
      (screen.getByLabelText("Odometer start") as HTMLInputElement).value,
    ).toBe("120");
    fireEvent.click(screen.getByRole("button", { name: "2026 tax year" }));
    expect(
      await screen.findByText(/before exporting the final tax-year PDF/i),
    ).toBeTruthy();
    const backup = JSON.stringify({
      version: 1,
      profile: {
        driverName: "Imported Driver",
        businessName: "Biztech",
        vehicleDescription: "2020 Honda Civic",
        businessUseStartDate: "2025-01-01",
      },
      annualMileage: [],
      trips: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const file = new File([backup], "backup.json", {
      type: "application/json",
    });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    expect(
      await screen.findByRole("heading", { name: "Replace all mileage data?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Alex Morgan")).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: {
        files: [
          new File([backup], "backup-again.json", { type: "application/json" }),
        ],
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace data" }),
    );
    expect(await screen.findByText("Imported Driver")).toBeTruthy();
  });

  it("exports a PDF after annual mileage is complete and surfaces report failures", async () => {
    const create = vi.fn(() => "blob:report");
    let downloadedFilename = "";
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = vi.fn();
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloadedFilename = this.download;
      },
    );
    render(<MileageApp />);
    completeProfile();
    fireEvent.change(screen.getByLabelText("Destination or area"), {
      target: { value: "San Jose" },
    });
    fireEvent.change(screen.getByLabelText("Business purpose"), {
      target: { value: "Client support" },
    });
    fireEvent.change(screen.getByLabelText("Odometer start"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Odometer end"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save trip" }));
    await screen.findByText("Client support");
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /opening and closing/i,
    );
    fireEvent.change(screen.getByLabelText("Opening odometer"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Closing/current odometer"), {
      target: { value: "1000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save annual mileage" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(downloadedFilename).toBe(
      "Alex-Morgan-mileage-2026-01-01-2026-12-31.pdf",
    );
    vi.mocked(createReport).mockRejectedValueOnce(new Error("pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /could not be created/i,
    );
  });

  it("clears all browser data only after confirmation", async () => {
    render(<MileageApp />);
    completeProfile();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all data" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Alex Morgan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all data" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear everything" }));
    expect(
      await screen.findByRole("heading", { name: "Set up your mileage log" }),
    ).toBeTruthy();
  });
});
