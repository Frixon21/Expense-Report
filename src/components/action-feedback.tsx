"use client";

export default function ActionFeedback({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (!message) return null;
  return <aside className="action-feedback" aria-label="Action feedback" onKeyDown={(event) => { if (event.key === "Escape") onDismiss(); }}>
    <p role="alert">{message}</p>
    <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
  </aside>;
}
