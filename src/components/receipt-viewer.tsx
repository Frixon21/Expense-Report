"use client";

import { useEffect } from "react";
import { Download, X } from "lucide-react";

export type ReceiptAttachment = {
  receiptFileName: string;
  receiptMimeType?: string;
  receiptDataUrl: string;
};

export function downloadReceipt({
  receiptFileName,
  receiptDataUrl,
}: ReceiptAttachment) {
  const link = document.createElement("a");
  link.href = receiptDataUrl;
  link.download = receiptFileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export function ReceiptViewButton({
  receipt,
  label = "View receipt",
  onOpen,
}: {
  receipt: ReceiptAttachment;
  label?: string;
  onOpen: (receipt: ReceiptAttachment) => void;
}) {
  return (
    <button
      type="button"
      className="receipt-view-btn"
      aria-label={`${label}: ${receipt.receiptFileName}`}
      title={label}
      onClick={() => onOpen(receipt)}
    >
      {label}
    </button>
  );
}

export function ReceiptViewerModal({
  receipt,
  onClose,
}: {
  receipt: ReceiptAttachment | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!receipt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receipt, onClose]);

  if (!receipt) return null;

  const isPdf =
    receipt.receiptMimeType === "application/pdf" ||
    receipt.receiptFileName.toLowerCase().endsWith(".pdf");

  return (
    <div
      className="modal-backdrop receipt-viewer-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="receipt-viewer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-viewer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="receipt-viewer-header">
          <h2 id="receipt-viewer-title">{receipt.receiptFileName}</h2>
          <div className="receipt-viewer-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => downloadReceipt(receipt)}
            >
              <Download size={15} aria-hidden />
              Download
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close receipt viewer"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="receipt-viewer-body">
          {isPdf ? (
            <iframe
              title={receipt.receiptFileName}
              src={receipt.receiptDataUrl}
              className="receipt-viewer-frame"
            />
          ) : (
            <img
              src={receipt.receiptDataUrl}
              alt={receipt.receiptFileName}
              className="receipt-viewer-image"
            />
          )}
        </div>
      </div>
    </div>
  );
}
