"use client";

import { useEffect, useState } from "react";
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
      {receipt.receiptMimeType?.startsWith("image/") && (
        <img
          loading="lazy"
          className="receipt-thumbnail"
          src={receipt.receiptDataUrl}
          alt="Receipt thumbnail"
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
        />
      )}
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
  const [rotation, setRotation] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setRotation(0);
    setFailed(false);
  }, [receipt]);
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

  const canOpenInNewTab = /^\/api\/expenses\/[^/?#]+\/receipt$/.test(
    receipt.receiptDataUrl,
  );
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
            {canOpenInNewTab && (
              <a
                className="secondary"
                href={receipt.receiptDataUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in new tab
              </a>
            )}
            {!(
              receipt.receiptMimeType === "application/pdf" ||
              receipt.receiptFileName.toLowerCase().endsWith(".pdf")
            ) && (
              <button
                type="button"
                className="secondary"
                onClick={() => setRotation((value) => (value + 90) % 360)}
              >
                Rotate view
              </button>
            )}
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
          {failed && (
            <p className="error" role="alert">
              Receipt preview could not be read. Download the original or attach
              a readable replacement. PDF preview availability depends on your
              browser.
            </p>
          )}
          {isPdf && (
            <p className="receipt-preview-note">
              If the PDF preview is unavailable,{" "}
              {canOpenInNewTab
                ? "open it in a new tab or download the original."
                : "download the original."}
            </p>
          )}
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
              style={{
                transform: `rotate(${rotation}deg)`,
                maxHeight: rotation % 180 ? "55vh" : "75vh",
              }}
              onError={() => setFailed(true)}
              className="receipt-viewer-image"
            />
          )}
        </div>
      </div>
    </div>
  );
}
