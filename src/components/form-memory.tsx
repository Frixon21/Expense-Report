"use client";
import { useEffect, useRef, useState } from "react";
const prefix = "biztech-form-v1:";
type Mode = { editing: string | null; duplicating: boolean };
type Draft<T> = { form: T; mode: Mode; savedAt: number };
export function clearUserDrafts(userId: string) {
  try {
    for (const module of ["expense", "mileage"])
      localStorage.removeItem(
        prefix + encodeURIComponent(userId) + ":" + module + ":draft",
      );
  } catch {}
}
export function useFormMemory<T extends Record<string, string>>(
  userId: string | undefined,
  module: string,
  form: T,
  setForm: (form: T) => void,
  preferences: (keyof T)[],
  mode: Mode,
  recoverMode: (mode: Mode) => boolean,
) {
  const base = userId
    ? prefix + encodeURIComponent(userId) + ":" + module
    : null;
  const [pending, setPending] = useState<Draft<T> | null>(null);
  const [warning, setWarning] = useState("");
  const ready = useRef(false),
    touched = useRef(false);
  useEffect(() => {
    if (!base) return;
    const parse = (raw: string | null) => {
      if (!raw || raw.length > 20000) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const validForm = (value: unknown): value is T =>
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(form).every(
        (k) =>
          (k === "vehicleId" && (value as T)[k] === undefined) ||
          (typeof (value as T)[k] === "string" &&
            (value as T)[k].length <= 2000),
      );
    try {
      const prefs = parse(localStorage.getItem(base + ":preferences"));
      if (prefs && typeof prefs === "object" && !Array.isArray(prefs))
        setForm({
          ...form,
          ...Object.fromEntries(
            preferences
              .filter(
                (k) => typeof prefs[k] === "string" && prefs[k].length <= 2000,
              )
              .map((k) => [k, prefs[k]]),
          ),
        });
      const draft = parse(localStorage.getItem(base + ":draft"));
      if (
        draft &&
        validForm(draft.form) &&
        draft.mode &&
        (draft.mode.editing === null ||
          typeof draft.mode.editing === "string") &&
        typeof draft.mode.duplicating === "boolean" &&
        typeof draft.savedAt === "number" &&
        Date.now() - draft.savedAt < 30 * 86400000
      )
        setPending(draft);
      else if (draft) localStorage.removeItem(base + ":draft");
    } catch {
      setWarning(
        "Draft recovery is unavailable because browser storage is blocked.",
      );
    }
    ready.current = true;
    const onStorage = (event: StorageEvent) => {
      if (event.key === base + ":draft" && event.newValue === null) {
        touched.current = false;
        setPending(null);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // Authenticated forms are keyed by user and module. Only allowlisted form strings are restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => {
    if (!base || !ready.current || !touched.current) return;
    try {
      localStorage.setItem(
        base + ":draft",
        JSON.stringify({ form, mode, savedAt: Date.now() }),
      );
    } catch {
      setWarning(
        "Your unfinished entry could not be saved on this browser. Keep this page open until you save.",
      );
    }
  }, [base, form, mode.editing, mode.duplicating]);
  return {
    touch: () => {
      touched.current = true;
    },
    remember: () => {
      if (!base) return;
      try {
        localStorage.setItem(
          base + ":preferences",
          JSON.stringify(
            Object.fromEntries(preferences.map((k) => [k, form[k]])),
          ),
        );
      } catch {
        setWarning("Form choices could not be remembered.");
      }
    },
    clear: () => {
      touched.current = false;
      setPending(null);
      if (base)
        try {
          localStorage.removeItem(base + ":draft");
        } catch {}
    },
    notice: (
      <>
        {pending && (
          <div className="draft-notice" role="status">
            <p>
              Recover your unfinished {module} entry? Review its date and
              details before saving.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (!recoverMode(pending.mode)) {
                  setWarning(
                    "This record was deleted or locked by payroll. Discard this draft and review your saved records.",
                  );
                  return;
                }
                setForm(
                  Object.fromEntries(
                    Object.keys(form).map((key) => [
                      key,
                      pending.form[key] ?? "",
                    ]),
                  ) as T,
                );
                touched.current = true;
                setPending(null);
              }}
            >
              Recover draft
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                touched.current = false;
                setPending(null);
                if (base)
                  try {
                    localStorage.removeItem(base + ":draft");
                  } catch {}
              }}
            >
              Discard draft
            </button>
          </div>
        )}
        {warning && <p role="status">{warning}</p>}
      </>
    ),
  };
}
