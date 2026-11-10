"use client";
import { useRef, useState } from "react";
import { newId } from "@/lib/new-id";
import {
  vehicleRecordSchema,
  type MileageState,
  type Vehicle,
} from "@/lib/model";
import { today } from "@/lib/date-defaults";
export default function VehicleManager({
  state,
  onChange,
}: {
  state: MileageState;
  onChange: (state: MileageState) => void | Promise<void>;
}) {
  const [description, setDescription] = useState(""),
    [start, setStart] = useState(today),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function save(
    vehicles: Vehicle[],
    defaultVehicleId = state.defaultVehicleId,
  ) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const selected = vehicles.find((v) => v.id === defaultVehicleId);
      await onChange({
        ...state,
        vehicles,
        defaultVehicleId,
        profile:
          state.profile && selected
            ? {
                ...state.profile,
                vehicleDescription: selected.description,
                businessUseStartDate: selected.businessUseStartDate,
              }
            : state.profile,
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save vehicles.");
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    const parsed = vehicleRecordSchema.safeParse({
      id: newId(),
      description,
      businessUseStartDate: start,
      retired: false,
    });
    if (!parsed.success || !start) {
      setError(
        parsed.success
          ? "Choose the business-use start date."
          : parsed.error.issues[0].message,
      );
      return;
    }
    if (
      await save(
        [...(state.vehicles ?? []), parsed.data],
        state.defaultVehicleId ?? parsed.data.id,
      )
    ) {
      setDescription("");
      setStart(today());
    }
  }
  return (
    <section>
      <h3>Vehicles</h3>
      <p>
        Choose a default for quick entry. Each car keeps its own odometer
        readings.
      </p>
      {state.vehicles?.map((v) => (
        <div className="trip-row" key={v.id}>
          <div>
            <strong>{v.description}</strong>
            <small>
              {v.id === state.defaultVehicleId ? " Default" : ""}
              {v.retired ? " · Retired" : ""}
            </small>
          </div>
          <div className="button-row">
            {!v.retired && v.id !== state.defaultVehicleId && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => save(state.vehicles!, v.id)}
              >
                Make default
              </button>
            )}
          </div>
        </div>
      ))}
      <label>
        Vehicle name
        <input
          maxLength={150}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Vehicle business-use start date
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
      </label>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={submit}
        >
          Add vehicle
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
