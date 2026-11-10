// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReceiptViewerModal } from "./receipt-viewer";
afterEach(() => cleanup());
const pdf = {
  receiptFileName: "synthetic.pdf",
  receiptMimeType: "application/pdf",
  receiptDataUrl: "/api/expenses/11111111-1111-4111-8111-111111111111/receipt",
};
it("keeps the PDF inline and offers a separate-tab fallback without waiting for unreliable frame errors", () => {
  render(<ReceiptViewerModal receipt={pdf} onClose={() => {}} />);
  expect(screen.getByTitle("synthetic.pdf")).toHaveAttribute(
    "src",
    pdf.receiptDataUrl,
  );
  const link = screen.getByRole("link", { name: "Open in new tab" });
  expect(link).toHaveAttribute("href", pdf.receiptDataUrl);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByText(/If the PDF preview is unavailable/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Rotate view" })).toBeNull();
});
it("resets failed image state and rotation on closing/reopening and retains close controls", () => {
  const close = vi.fn(),
    image = {
      ...pdf,
      receiptMimeType: "image/png",
      receiptFileName: "synthetic.png",
    };
  const view = render(<ReceiptViewerModal receipt={image} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Rotate view" }));
  expect(screen.getByAltText("synthetic.png")).toHaveStyle({
    transform: "rotate(90deg)",
  });
  fireEvent.error(screen.getByAltText("synthetic.png"));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Receipt preview could not be read",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close receipt viewer" }));
  expect(close).toHaveBeenCalledTimes(1);
  view.rerender(<ReceiptViewerModal receipt={null} onClose={close} />);
  view.rerender(<ReceiptViewerModal receipt={{ ...image }} onClose={close} />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByAltText("synthetic.png")).toHaveStyle({
    transform: "rotate(0deg)",
  });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(2);
});
it("does not offer a blocked top-level data URL navigation for an unsaved attachment", () => {
  render(
    <ReceiptViewerModal
      receipt={{
        ...pdf,
        receiptDataUrl: "data:application/pdf;base64,JVBERi0=",
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByTitle("synthetic.pdf")).toHaveAttribute(
    "src",
    "data:application/pdf;base64,JVBERi0=",
  );
  expect(screen.queryByRole("link", { name: "Open in new tab" })).toBeNull();
  expect(screen.getByRole("button", { name: "Download" })).toBeVisible();
});
