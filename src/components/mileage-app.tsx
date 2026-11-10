"use client";
import { useFormMemory } from "@/components/form-memory";
import VehicleManager from "@/components/vehicle-manager";
import PayPeriodNote from "@/components/pay-period-note";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Copy,
  Download,
  FileUp,
  Pencil,
  Route,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  withLegacyVehicle,
  tripVehicleLabel,
  annualMileageComplete,
  annualMileageInputSchema,
  dateRangePresets,
  emptyState,
  formatDollars,
  formatMiles,
  isFullTaxYearRange,
  lastTripEndTenths,
  profileSchema,
  safeFilenamePart,
  tenthsToOdometerInput,
  totalBusinessMiles,
  tripInputSchema,
  type MileageState,
  type Profile,
  type Trip,
} from "@/lib/model";
import { exportState, importState, loadState, saveState } from "@/lib/storage";
import { createReport } from "@/lib/pdf";
import { newId } from "@/lib/new-id";
import { today, monthStart, monthEnd } from "@/lib/date-defaults";
import { downloadBlob } from "@/lib/download";
import {
  defaultTripMeta,
  isPayrollLocked,
  payrollLockLabel,
  type TripPayrollMeta,
} from "@/lib/demo-types";

const BUSINESS_NAME = "Biztech";

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Biztech mileage home">
      <span className="brand-icon">
        <Route size={22} />
      </span>
      <span>
        Biztech
        <small>MILEAGE LOG</small>
      </span>
    </a>
  );
}

export default function MileageApp() {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<MileageState>(emptyState);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const loaded = loadState();
    const normalized = loaded.profile
      ? {
          ...loaded,
          profile: { ...loaded.profile, businessName: BUSINESS_NAME },
        }
      : loaded;
    setState(normalized);
    setReady(true);
  }, []);
  const update = (next: MileageState) => {
    try {
      saveState(next);
      setState(next);
      setStorageError("");
    } catch {
      setStorageError(
        "This browser could not save your changes. Check browser storage settings and try again.",
      );
    }
  };
  if (!ready)
    return (
      <div className="loading-screen" data-testid="app-loading-shell">
        <strong>Biztech Mileage Log</strong>
        <p>Loading your saved records…</p>
      </div>
    );
  if (!state.profile)
    return (
      <ProfileSetup
        onSave={(profile) => update({ ...state, profile })}
        error={storageError}
      />
    );
  return (
    <Dashboard state={state} onChange={update} storageError={storageError} />
  );
}

function ProfileFields({
  value,
  onChange,
}: {
  value: Profile;
  onChange: (value: Profile) => void;
}) {
  return (
    <div className="form-grid">
      <label>
        Driver full name
        <input
          required
          autoComplete="name"
          value={value.driverName}
          onChange={(e) => onChange({ ...value, driverName: e.target.value })}
        />
      </label>
      <label>
        Vehicle description
        <input
          required
          placeholder="Year, make, model"
          value={value.vehicleDescription}
          onChange={(e) =>
            onChange({ ...value, vehicleDescription: e.target.value })
          }
        />
      </label>
      <label>
        First used for business
        <input
          required
          type="date"
          value={value.businessUseStartDate}
          onChange={(e) =>
            onChange({ ...value, businessUseStartDate: e.target.value })
          }
        />
      </label>
    </div>
  );
}

export function ProfileSetup({
  onSave,
  error,
  historyContent,
  embedded = false,
  storageNote = "Records stay in this browser. Browser data can be cleared, so download a backup regularly.",
}: {
  onSave: (profile: Profile) => void | Promise<void>;
  error: string;
  historyContent?: ReactNode;
  embedded?: boolean;
  storageNote?: string;
}) {
  const [profile, setProfile] = useState<Profile>({
    driverName: "",
    businessName: BUSINESS_NAME,
    vehicleDescription: "",
    businessUseStartDate: "",
  });
  const [formError, setFormError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success)
      return setFormError(
        parsed.error.issues[0]?.message ?? "Complete all required fields.",
      );
    setFormError("");
    onSave(parsed.data);
  };
  return (
    <main className="setup-page">
      <div className="setup-wrap">
        {!embedded && <Brand />}
        <section className="setup-card">
          <p className="section-kicker">LOCAL MILEAGE RECORD</p>
          <h1>Set up your mileage log</h1>
          <p>
            These details identify the driver and vehicle on Biztech mileage
            reports.
          </p>
          <form onSubmit={submit}>
            <ProfileFields value={profile} onChange={setProfile} />
            {(formError || error) && (
              <p className="error" role="alert">
                {formError || error}
              </p>
            )}
            <button className="primary">Save profile</button>
          </form>
          <p className="storage-note">{storageNote}</p>
        </section>
        {historyContent}
      </div>
    </main>
  );
}

type TripForm = {
  vehicleId: string;
  date: string;
  destination: string;
  businessPurpose: string;
  start: string;
  end: string;
  parking: string;
  tolls: string;
};
const newTrip = (suggestedStart = ""): TripForm => ({
  vehicleId: "",
  date: today(),
  destination: "",
  businessPurpose: "",
  start: suggestedStart,
  end: "",
  parking: "",
  tolls: "",
});

export function Dashboard({
  state: incomingState,
  onChange,
  storageError = "",
  payrollMeta = {},
  storageLabel = "Saved in this browser",
  footerNote = "Local browser storage | Download backups regularly | Supports recordkeeping, not tax advice",
  onReport,
  historyContent,
  memoryUserId,
  embedded = false,
}: {
  memoryUserId?: string;
  state: MileageState;
  onChange: (state: MileageState) => void | Promise<void>;
  storageError?: string;
  payrollMeta?: Record<string, TripPayrollMeta>;
  storageLabel?: string;
  footerNote?: string;
  onReport?: (from: string, to: string) => Promise<Blob>;
  historyContent?: ReactNode;
  embedded?: boolean;
}) {
  const [legacyId] = useState(newId);
  const state = useMemo(
    () => withLegacyVehicle(incomingState, legacyId),
    [incomingState, legacyId],
  );
  const itemMeta = (tripId: string) => payrollMeta[tripId] ?? defaultTripMeta();
  const [form, setForm] = useState<TripForm>(() => ({
    ...newTrip(),
    vehicleId: state.defaultVehicleId ?? "",
  }));
  const startFor = (vehicleId: string, trips = state.trips) => {
    const tenths = lastTripEndTenths(
      trips.filter((t) => t.vehicleId === vehicleId),
    );
    const annual = state.annualMileage.find(
      (a) =>
        a.vehicleId === vehicleId && a.year === Number(form.date.slice(0, 4)),
    );
    const reading = tenths ?? annual?.opening_tenths ?? null;
    return reading === null ? "" : tenthsToOdometerInput(reading);
  };
  const suggestedStart = startFor(form.vehicleId);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const saving = useRef(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Trip | null>(null);
  const [settings, setSettings] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reportError, setReportError] = useState("");
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);
  const memory = useFormMemory(
    memoryUserId,
    "mileage",
    form,
    setForm,
    ["destination"],
    { editing, duplicating },
    (mode) => {
      if (
        mode.editing &&
        (!state.trips.some((item) => item.id === mode.editing) ||
          isPayrollLocked(itemMeta(mode.editing)))
      )
        return false;
      setEditing(mode.editing);
      setDuplicating(mode.duplicating);
      setConfirmed(false);
      return true;
    },
  );
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!editing && !form.start && suggestedStart) {
      setForm((current) => ({ ...current, start: suggestedStart }));
    }
  }, [suggestedStart, editing, form.start]);
  const visible = useMemo(
    () =>
      state.trips
        .filter((trip) => trip.date >= from && trip.date <= to)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [state.trips, from, to],
  );
  const calculated =
    /^\d+(\.\d)?$/.test(form.start) && /^\d+(\.\d)?$/.test(form.end)
      ? Math.round(Number(form.end) * 10) - Math.round(Number(form.start) * 10)
      : 0;
  const setField = (field: keyof TripForm, value: string) => {
    memory.touch();
    setConfirmed(false);
    setForm((current) =>
      field === "vehicleId"
        ? { ...current, vehicleId: value, start: startFor(value), end: "" }
        : { ...current, [field]: value },
    );
  };
  const reset = (trips = state.trips) => {
    const vehicleId = state.vehicles?.some(
      (v) => v.id === form.vehicleId && !v.retired,
    )
      ? form.vehicleId
      : (state.defaultVehicleId ?? "");
    memory.clear();
    setDuplicating(false);
    setConfirmed(false);
    setForm({
      ...newTrip(startFor(vehicleId, trips)),
      vehicleId,
      destination: memoryUserId ? form.destination : "",
    });
    setEditing(null);
    setError("");
  };
  useEffect(() => {
    if (editing && isPayrollLocked(itemMeta(editing))) {
      setForm(newTrip(suggestedStart));
      setEditing(null);
      setError("");
      setMessage(
        "This trip was locked by payroll and can no longer be edited.",
      );
    }
  }, [editing, payrollMeta, suggestedStart]);
  const saveTrip = async (event: FormEvent) => {
    event.preventDefault();
    if (saving.current) return;
    if (duplicating && !confirmed) {
      setError(
        "Confirm the new date, distance and costs before saving the duplicate.",
      );
      return;
    }
    saving.current = true;
    setSaveBusy(true);
    setError("");
    setMessage("");
    try {
      const parsed = tripInputSchema.safeParse(form);
      if (!parsed.success)
        return setError(
          parsed.error.issues[0]?.message ?? "Check the trip details.",
        );
      if (editing && isPayrollLocked(itemMeta(editing))) {
        return setError(
          "This trip was locked by payroll and can no longer be edited.",
        );
      }
      const old = editing
        ? state.trips.find((trip) => trip.id === editing)
        : undefined;
      const vehicle = state.vehicles?.find((v) => v.id === form.vehicleId);
      if (!vehicle || (vehicle.retired && old?.vehicleId !== vehicle.id))
        return setError("Choose an active vehicle for this trip.");
      const trip: Trip = {
        id: editing ?? newId(),
        ...parsed.data,
        vehicleName:
          old?.vehicleId === vehicle.id
            ? (old.vehicleName ?? vehicle.description)
            : vehicle.description,
        vehicleBusinessUseStartDate:
          old?.vehicleId === vehicle.id
            ? (old.vehicleBusinessUseStartDate ?? vehicle.businessUseStartDate)
            : vehicle.businessUseStartDate,
        createdAt: old?.createdAt ?? new Date().toISOString(),
      };
      const trips = [
        ...state.trips.filter((item) => item.id !== trip.id),
        trip,
      ];
      const saveResult = onChange({
        ...state,
        trips,
      });
      if (saveResult && typeof saveResult.then === "function") await saveResult;
      memory.remember();
      setMessage(editing ? "Trip updated." : "Trip saved.");
      reset(trips);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save this trip.",
      );
    } finally {
      saving.current = false;
      setSaveBusy(false);
    }
  };
  const editTrip = (trip: Trip) => {
    if (isPayrollLocked(itemMeta(trip.id))) return;
    memory.touch();
    setDuplicating(false);
    setConfirmed(false);
    setForm({
      vehicleId: trip.vehicleId ?? "",
      date: trip.date,
      destination: trip.destination,
      businessPurpose: trip.businessPurpose,
      start: String(trip.start_tenths / 10),
      end: String(trip.end_tenths / 10),
      parking: trip.parking_cents ? String(trip.parking_cents / 100) : "",
      tolls: trip.tolls_cents ? String(trip.tolls_cents / 100) : "",
    });
    setEditing(trip.id);
    setError("");
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  const duplicateTrip = (trip: Trip) => {
    memory.touch();
    setEditing(null);
    setDuplicating(true);
    setConfirmed(false);
    setError("");
    setForm({
      ...newTrip(
        startFor(
          state.vehicles?.some((v) => v.id === trip.vehicleId && !v.retired)
            ? trip.vehicleId!
            : (state.defaultVehicleId ?? ""),
        ),
      ),
      vehicleId: state.vehicles?.some(
        (v) => v.id === trip.vehicleId && !v.retired,
      )
        ? trip.vehicleId!
        : (state.defaultVehicleId ?? ""),
      destination: trip.destination,
      businessPurpose: trip.businessPurpose,
    });
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  const reportYear = Number(from.slice(0, 4));
  const isFullTaxYear = isFullTaxYearRange(from, to);
  const missingAnnual =
    isFullTaxYear && !annualMileageComplete(state, reportYear);
  const rangePresets = useMemo(() => dateRangePresets(), []);
  const downloadReport = async () => {
    setReportError("");
    if (from > to)
      return setReportError("Choose an end date on or after the start date.");
    if (missingAnnual) {
      setReportError(
        `Add opening and closing odometer readings for ${reportYear} before creating the final tax-year report.`,
      );
      setSettings(true);
      return;
    }
    try {
      const report = onReport
        ? await onReport(from, to)
        : new Blob([new Uint8Array(await createReport({ state, from, to }))], {
            type: "application/pdf",
          });
      downloadBlob(
        report,
        `${safeFilenamePart(state.profile!.driverName)}-mileage-${from}-${to}.pdf`,
      );
    } catch {
      setReportError(
        "The report could not be created. Check your records and try again.",
      );
    }
  };
  return (
    <div className="app-shell">
      {!embedded && (
        <header className="topbar">
          <Brand />
          <div className="header-right">
            <div className="user-name">
              {state.profile?.driverName}
              <small>{state.profile?.vehicleDescription}</small>
            </div>
            <button className="secondary" onClick={() => setSettings(true)}>
              <Settings size={17} /> Settings
            </button>
          </div>
        </header>
      )}
      <main className="workspace">
        <div className="page-heading">
          <div>
            <p className="section-kicker">BUSINESS MILEAGE RECORD</p>
            <h1>Mileage log</h1>
            <p>
              {embedded
                ? [state.profile?.driverName, state.profile?.vehicleDescription]
                    .filter(Boolean)
                    .join(" · ")
                : state.profile?.businessName}
            </p>
          </div>
          {embedded ? (
            <button
              type="button"
              className="secondary"
              onClick={() => setSettings(true)}
            >
              <Settings size={17} /> Settings
            </button>
          ) : (
            <div className="storage-pill">{storageLabel}</div>
          )}
        </div>
        <section className="summary-grid">
          <article>
            <span>Business miles</span>
            <strong>{formatMiles(totalBusinessMiles(visible))}</strong>
            <small>Selected date range</small>
          </article>
          <article>
            <span>Trips</span>
            <strong>{visible.length}</strong>
            <small>Selected date range</small>
          </article>
          <article>
            <span>Parking and tolls</span>
            <strong>
              {formatDollars(
                visible.reduce(
                  (sum, trip) => sum + trip.parking_cents + trip.tolls_cents,
                  0,
                ),
              )}
            </strong>
            <small>Selected date range</small>
          </article>
        </section>
        {missingAnnual && from <= to && (
          <p className="tax-year-banner" role="status">
            Add opening and closing odometer readings for {reportYear} in
            Settings before exporting the final tax-year PDF.
            <button
              type="button"
              className="link-button"
              onClick={() => setSettings(true)}
            >
              Open settings
            </button>
          </p>
        )}
        {(storageError || reportError) && (
          <p className="error global-message" role="alert">
            {storageError || reportError}
          </p>
        )}
        {message && (
          <p className="success" role="status">
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage("")}>
              <X size={15} />
            </button>
          </p>
        )}
        <div className="dashboard-grid">
          <section className="panel trip-panel">
            <div className="section-heading">
              <span className="step">1</span>
              <div>
                <h2>{editing ? "Edit trip" : "Add a trip"}</h2>
                <p>Record each completed business trip.</p>
              </div>
            </div>
            {state.vehicleMigrationWarning && (
              <p role="alert">{state.vehicleMigrationWarning}</p>
            )}
            {memory.notice}
            <form ref={formRef} onSubmit={saveTrip}>
              <label>
                Trip vehicle
                <select
                  required
                  className="vehicle-select"
                  value={form.vehicleId}
                  onChange={(e) => setField("vehicleId", e.target.value)}
                >
                  <option value="">Choose a vehicle</option>
                  {state.vehicles
                    ?.filter((v) => !v.retired || v.id === form.vehicleId)
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.description}
                        {v.retired ? " (retired)" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Date
                <input
                  type="date"
                  required
                  value={form.date}
                  onChange={(e) => setField("date", e.target.value)}
                />
              </label>
              <label>
                Destination or area
                <input
                  required
                  maxLength={200}
                  value={form.destination}
                  onChange={(e) => setField("destination", e.target.value)}
                />
              </label>
              <label>
                Business purpose
                <textarea
                  required
                  maxLength={500}
                  rows={3}
                  value={form.businessPurpose}
                  onChange={(e) => setField("businessPurpose", e.target.value)}
                />
              </label>
              <div className="split">
                <label>
                  Odometer start
                  <input
                    inputMode="decimal"
                    required
                    value={form.start}
                    onChange={(e) => setField("start", e.target.value)}
                  />
                </label>
                <label>
                  Odometer end
                  <input
                    inputMode="decimal"
                    required
                    value={form.end}
                    onChange={(e) => setField("end", e.target.value)}
                  />
                </label>
              </div>
              <div className="calculated">
                <span>Trip distance</span>
                <strong data-testid="calculated-miles">
                  {formatMiles(Math.max(0, calculated))} mi
                </strong>
              </div>
              <div className="split">
                <label>
                  Parking <small>(optional)</small>
                  <input
                    inputMode="decimal"
                    value={form.parking}
                    onChange={(e) => setField("parking", e.target.value)}
                  />
                </label>
                <label>
                  Tolls <small>(optional)</small>
                  <input
                    inputMode="decimal"
                    value={form.tolls}
                    onChange={(e) => setField("tolls", e.target.value)}
                  />
                </label>
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
                {duplicating && (
                  <label className="duplicate-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I confirm the new date, distance and costs are accurate.
                  </label>
                )}
                <button className="primary" disabled={saveBusy}>
                  {editing ? "Update trip" : "Save trip"}
                </button>
                {(editing || duplicating) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={saveBusy}
                    onClick={() => reset()}
                  >
                    {duplicating ? "Cancel duplicate" : "Cancel editing"}
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="panel history-panel">
            <div className="history-heading">
              <div>
                <span className="step">2</span>
                <div>
                  <h2>Trips and reports</h2>
                  <p>Filter records, review details, and create a PDF.</p>
                </div>
              </div>
              <button
                className="secondary"
                onClick={() => void downloadReport()}
              >
                <Download size={16} /> Export PDF
              </button>
            </div>
            <div className="range-toolbar">
              <div className="range">
                <label>
                  From
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              <div className="range-presets">
                {rangePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="preset-chip"
                    onClick={() => {
                      setFrom(preset.from);
                      setTo(preset.to);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <PayPeriodNote from={from} to={to} />
            {from > to ? (
              <p className="empty-line">
                Choose an end date on or after the start date.
              </p>
            ) : visible.length ? (
              <div className="trip-list">
                {visible.map((trip) => {
                  const locked = isPayrollLocked(itemMeta(trip.id));
                  const lockLabel = payrollLockLabel(itemMeta(trip.id));
                  return (
                    <article
                      className={
                        locked ? "trip-row payroll-locked-row" : "trip-row"
                      }
                      key={trip.id}
                    >
                      <div className="trip-date">
                        {new Date(`${trip.date}T12:00:00`).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric", year: "numeric" },
                        )}
                      </div>
                      <div className="trip-detail">
                        <strong>{trip.businessPurpose}</strong>
                        <span>{trip.destination}</span>
                        <small>Vehicle: {tripVehicleLabel(state, trip)}</small>
                        <small>
                          {formatMiles(trip.start_tenths)} →{" "}
                          {formatMiles(trip.end_tenths)} · Expenses{" "}
                          {formatDollars(trip.parking_cents + trip.tolls_cents)}
                          {lockLabel ? ` · ${lockLabel}` : ""}
                        </small>
                      </div>
                      <strong className="trip-miles">
                        {formatMiles(trip.end_tenths - trip.start_tenths)} mi
                      </strong>
                      <div className="row-actions">
                        <button
                          type="button"
                          aria-label={`Duplicate ${trip.businessPurpose}`}
                          disabled={saveBusy}
                          onClick={() => duplicateTrip(trip)}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit ${trip.businessPurpose}`}
                          disabled={locked || saveBusy}
                          title={
                            locked
                              ? "Locked after payroll marked this trip processed or paid"
                              : undefined
                          }
                          onClick={() => editTrip(trip)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${trip.businessPurpose}`}
                          disabled={locked || saveBusy}
                          title={
                            locked
                              ? "Locked after payroll marked this trip processed or paid"
                              : undefined
                          }
                          onClick={() => setDeleting(trip)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty">
                <Route size={30} />
                <h3>No trips in this date range</h3>
                <p>Add a trip or change the dates above.</p>
              </div>
            )}
          </section>
        </div>
        {historyContent}
        <footer className="workspace-footer">
          <span>Biztech Mileage Log</span>
          <span>{footerNote}</span>
        </footer>
      </main>
      {settings && (
        <SettingsPanel
          state={state}
          onChange={onChange}
          onClose={() => setSettings(false)}
          onClear={() => onChange(emptyState())}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete this trip?"
          detail="This removes the trip from this browser."
          cancel="Keep trip"
          confirm="Delete trip"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (isPayrollLocked(itemMeta(deleting.id))) {
              setDeleting(null);
              return;
            }
            try {
              const saveResult = onChange({
                ...state,
                trips: state.trips.filter((trip) => trip.id !== deleting.id),
              });
              if (saveResult && typeof saveResult.then === "function")
                await saveResult;
              setDeleting(null);
              if (editing === deleting.id) reset();
            } catch (reason) {
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not delete this trip.",
              );
            }
          }}
        />
      )}
    </div>
  );
}

function SettingsPanel({
  state,
  onChange,
  onClose,
  onClear,
}: {
  state: MileageState;
  onChange: (state: MileageState) => void | Promise<void>;
  onClose: () => void;
  onClear: () => void | Promise<void>;
}) {
  const [profile, setProfile] = useState(state.profile!);
  const current = new Date().getFullYear();
  const [annualVehicle, setAnnualVehicle] = useState(
    state.defaultVehicleId ?? "",
  );
  const initialAnnual = state.annualMileage.find(
    (item) => item.year === current && item.vehicleId === annualVehicle,
  );
  const [year, setYear] = useState(current);
  const [opening, setOpening] = useState(
    initialAnnual?.opening_tenths == null
      ? ""
      : String(initialAnnual.opening_tenths / 10),
  );
  const [closing, setClosing] = useState(
    initialAnnual?.closing_tenths == null
      ? ""
      : String(initialAnnual.closing_tenths / 10),
  );
  const [error, setError] = useState("");
  const [clear, setClear] = useState(false);
  const [pendingImport, setPendingImport] = useState<MileageState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || clear || pendingImport) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, clear, pendingImport]);
  const selectYear = (nextYear: number, vehicleId = annualVehicle) => {
    const record = state.annualMileage.find(
      (item) => item.year === nextYear && item.vehicleId === vehicleId,
    );
    setYear(nextYear);
    setOpening(
      record?.opening_tenths == null ? "" : String(record.opening_tenths / 10),
    );
    setClosing(
      record?.closing_tenths == null ? "" : String(record.closing_tenths / 10),
    );
  };
  const saveProfile = async () => {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success)
      return setError(
        parsed.error.issues[0]?.message ?? "Complete the profile.",
      );
    try {
      const saveResult = onChange({
        ...state,
        profile: parsed.data,
        vehicles: state.vehicles?.map((v) =>
          v.id === state.defaultVehicleId
            ? {
                ...v,
                description: parsed.data.vehicleDescription,
                businessUseStartDate: parsed.data.businessUseStartDate,
              }
            : v,
        ),
      });
      if (saveResult && typeof saveResult.then === "function") await saveResult;
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not save profile.",
      );
    }
  };
  const saveAnnual = async () => {
    const parsed = annualMileageInputSchema.safeParse({
      vehicleId: annualVehicle || undefined,
      year,
      opening,
      closing,
    });
    if (!parsed.success)
      return setError(
        parsed.error.issues[0]?.message ?? "Check annual mileage.",
      );
    try {
      const saveResult = onChange({
        ...state,
        annualMileage: [
          ...state.annualMileage.filter(
            (item) => item.year !== year || item.vehicleId !== annualVehicle,
          ),
          parsed.data,
        ],
      });
      if (saveResult && typeof saveResult.then === "function") await saveResult;
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save annual mileage.",
      );
    }
  };
  const importBackup = async (file?: File) => {
    if (!file) return;
    if (fileRef.current) fileRef.current.value = "";
    try {
      const imported = importState(await file.text());
      const normalized = imported.profile
        ? {
            ...imported,
            profile: { ...imported.profile, businessName: BUSINESS_NAME },
          }
        : imported;
      setPendingImport(normalized);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  const applyImport = async () => {
    if (!pendingImport) return;
    try {
      const saveResult = onChange(pendingImport);
      if (saveResult && typeof saveResult.then === "function") await saveResult;
      setProfile(pendingImport.profile ?? profile);
      setPendingImport(null);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not import this backup.",
      );
    }
  };
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="drawer-heading">
          <div>
            <h2>Settings</h2>
            <p>Profile, annual mileage, and browser backup.</p>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <section>
          <h3>Driver and vehicle</h3>
          <ProfileFields value={profile} onChange={setProfile} />
          <button className="secondary" onClick={saveProfile}>
            Save profile changes
          </button>
        </section>
        <VehicleManager
          state={state}
          onChange={async (next) => {
            await onChange(next);
            setProfile(next.profile!);
          }}
        />
        <section>
          <h3>Annual odometer readings</h3>
          <label>
            Annual readings vehicle
            <select
              className="vehicle-select"
              value={annualVehicle}
              onChange={(e) => {
                setAnnualVehicle(e.target.value);
                selectYear(year, e.target.value);
              }}
            >
              {state.vehicles?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.description}
                  {v.retired ? " (retired)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p>
            Opening and closing/current readings substantiate total annual
            vehicle mileage. The closing/current reading can be added later, but
            is required before a final full-year report.
          </p>
          <div className="form-grid annual-grid">
            <label>
              Tax year
              <input
                type="number"
                min="1900"
                max="9999"
                value={year}
                onChange={(e) => selectYear(Number(e.target.value))}
              />
            </label>
            <label>
              Opening odometer
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </label>
            <label>
              Closing/current odometer
              <input
                inputMode="decimal"
                value={closing}
                onChange={(e) => setClosing(e.target.value)}
              />
            </label>
          </div>
          {opening && !closing && (
            <p className="annual-note">
              Closing/current odometer is needed for the final full-year report.
            </p>
          )}
          <button className="secondary" onClick={saveAnnual}>
            Save annual mileage
          </button>
        </section>
        <section>
          <h3>Backup and restore</h3>
          <p>
            Browser data can be cleared by browser settings, device resets, or
            private browsing. Download a backup and store it safely.
          </p>
          <div className="button-row">
            <button
              className="secondary"
              onClick={() =>
                downloadBlob(
                  new Blob([exportState(state)], { type: "application/json" }),
                  `mileage-backup-${today()}.json`,
                )
              }
            >
              <Download size={16} /> Download backup
            </button>
            <button
              className="secondary"
              onClick={() => fileRef.current?.click()}
            >
              <FileUp size={16} /> Import backup
            </button>
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(e) => void importBackup(e.target.files?.[0])}
            />
          </div>
        </section>
        <section className="danger-zone">
          <h3>Clear browser data</h3>
          <p>
            Delete the profile, annual mileage, and every trip saved in this
            browser.
          </p>
          <button className="danger-button" onClick={() => setClear(true)}>
            Clear all data
          </button>
        </section>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </aside>
      {clear && (
        <Confirm
          title="Clear all mileage data?"
          detail="This cannot be undone unless you downloaded a backup."
          cancel="Cancel"
          confirm="Clear everything"
          onCancel={() => setClear(false)}
          onConfirm={() => {
            setClear(false);
            onClose();
            onClear();
          }}
        />
      )}
      {pendingImport && (
        <Confirm
          title="Replace all mileage data?"
          detail="Importing a backup replaces the profile, annual mileage, and every trip saved in this browser."
          cancel="Cancel"
          confirm="Replace data"
          onCancel={() => setPendingImport(null)}
          onConfirm={applyImport}
        />
      )}
    </div>
  );
}

function Confirm({
  title,
  detail,
  cancel,
  confirm,
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  cancel: string;
  confirm: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{title}</h2>
        <p>{detail}</p>
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>
            {cancel}
          </button>
          <button className="danger-button" onClick={() => void onConfirm()}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
