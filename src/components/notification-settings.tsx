"use client";
import { newId } from "@/lib/new-id";
import { useEffect, useRef, useState, type FormEvent } from "react";
type Settings = {
  enabled: boolean;
  from: string;
  reviewUrl: string;
  recipient: string;
  testRecipient: string;
  keyConfigured: boolean;
  deliveryApproved: boolean;
  counts: { status: string; count: number }[];
};
export function NotificationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const testId = useRef<string | null>(null);
  async function load() {
    const r = await fetch("/api/admin/notifications", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok || typeof data.enabled !== "boolean")
      throw new Error("Notification settings unavailable.");
    setSettings(data);
  }
  useEffect(() => {
    void load().catch(() => setMessage("Notification settings unavailable."));
  }, []);
  async function act(action: "save" | "test" | "retry") {
    if (pending.current || !settings) return;
    if (
      action === "test" &&
      !window.confirm(`Send a test notification to ${settings.testRecipient}?`)
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (action === "test") testId.current ??= newId();
      const r = await fetch("/api/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          settings: {
            enabled: settings.enabled,
            recipient: settings.recipient,
            from: settings.from,
            reviewUrl: settings.reviewUrl,
          },
          requestId: action === "test" ? testId.current : undefined,
        }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Notification action failed.");
      if (action === "test") testId.current = null;
      await load();
      setMessage(
        action === "save"
          ? "Notification settings saved."
          : "Delivery queued. Refresh settings to check the result.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Notification action failed.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (!settings)
    return (
      <section className="panel">
        <h2>Email notifications</h2>
        <p>{message || "Loading notification settings..."}</p>
      </section>
    );
  const ready =
    settings.enabled && settings.keyConfigured && settings.deliveryApproved;
  return (
    <section className="panel">
      <h2>Email notifications</h2>
      <p>
        One email for each new expense or mileage entry. Edits do not send
        email. Recipient: {settings.recipient}
      </p>
      <form
        className="form-grid"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act("save");
        }}
      >
        <label className="admin-option">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) =>
              setSettings({ ...settings, enabled: e.target.checked })
            }
          />{" "}
          Enable notifications
        </label>
        <label>
          Recipient
          <input
            type="email"
            value={settings.recipient}
            required
            disabled={busy}
            onChange={(e) =>
              setSettings({ ...settings, recipient: e.target.value })
            }
          />
        </label>
        <label>
          From
          <input
            value={settings.from}
            required
            disabled={busy}
            onChange={(e) => setSettings({ ...settings, from: e.target.value })}
          />
        </label>
        <label>
          Review URL
          <input
            type="url"
            value={settings.reviewUrl}
            required
            disabled={busy}
            onChange={(e) =>
              setSettings({ ...settings, reviewUrl: e.target.value })
            }
          />
        </label>
        <button disabled={busy}>Save notification settings</button>
      </form>
      <p>
        Server key: {settings.keyConfigured ? "configured" : "not configured"}.
        External delivery:{" "}
        {settings.deliveryApproved
          ? "approved at runtime"
          : "disabled at runtime"}
        . No API key is entered in this page. Test emails always go to{" "}
        {settings.testRecipient}.
      </p>
      <p>
        {settings.counts.map((c) => `${c.status}: ${c.count}`).join("; ") ||
          "No delivery events."}
      </p>
      <button
        type="button"
        className="secondary"
        disabled={busy || !ready}
        onClick={() => void act("test")}
      >
        Send test email
      </button>{" "}
      <button
        type="button"
        className="secondary"
        disabled={busy || !ready}
        onClick={() => void act("retry")}
      >
        Retry due notifications
      </button>{" "}
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() =>
          void load().catch(() => setMessage("Could not refresh settings."))
        }
      >
        Refresh delivery status
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
