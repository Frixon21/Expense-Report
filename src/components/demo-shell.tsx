"use client";

import { useEffect, useState } from "react";
import ThemePicker from "@/components/theme-picker";
import { Receipt, Route } from "lucide-react";
import { Dashboard } from "@/components/mileage-app";
import ExpenseDashboard from "@/components/expense-dashboard";
import PayrollDashboard from "@/components/payroll-dashboard";
import type { Expense } from "@/lib/expense";
import type { DemoOrg } from "@/lib/demo-types";
import { probeBrowserStorage } from "@/lib/browser-storage";
import { loadDemoOrg, resetDemoOrg, saveDemoOrg } from "@/lib/demo-storage";
import {
  mergeExpensesWithPayrollLocks,
  mergeTripsWithPayrollLocks,
} from "@/lib/payroll-lock";
import type { MileageState } from "@/lib/model";

type ViewMode = "employee" | "payroll";
type EmployeeModule = "mileage" | "expenses";

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Biztech expense report home">
      <span className="brand-icon">
        <Route size={22} />
      </span>
      <span>
        Biztech
        <small>EXPENSE REPORT</small>
      </span>
    </a>
  );
}

export default function DemoShell() {
  const [ready, setReady] = useState(false);
  const [org, setOrg] = useState<DemoOrg | null>(null);
  const [view, setView] = useState<ViewMode>("employee");
  const [employeeModule, setEmployeeModule] =
    useState<EmployeeModule>("mileage");
  const [employeeId, setEmployeeId] = useState("emp-alex");
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    const storageIssue = probeBrowserStorage();
    if (storageIssue) setStorageError(storageIssue);
    const loaded = loadDemoOrg();
    setOrg(loaded);
    setEmployeeId(loaded.employees[0]?.id ?? "emp-alex");
    setReady(true);
  }, []);

  const persist = (next: DemoOrg) => {
    try {
      saveDemoOrg(next);
      setOrg(next);
      setStorageError("");
    } catch (error) {
      setStorageError(
        error instanceof Error
          ? error.message
          : "This browser could not save demo changes. Check browser storage settings.",
      );
    }
  };

  const handleReset = () => {
    const seeded = resetDemoOrg();
    setOrg(seeded);
    setEmployeeId(seeded.employees[0]?.id ?? "emp-alex");
    setStorageError("");
  };

  if (!ready || !org) {
    return (
      <div className="loading-screen" data-testid="app-loading-shell">
        <strong>Biztech Expense Report</strong>
        <p>Loading demo…</p>
      </div>
    );
  }

  const active =
    org.employees.find((employee) => employee.id === employeeId) ??
    org.employees[0];

  const updateEmployeeState = (state: MileageState) => {
    if (!active) return;
    const tripMeta = { ...active.tripMeta };
    for (const trip of state.trips) {
      if (!tripMeta[trip.id]) {
        tripMeta[trip.id] = { processed: false, paid: false };
      }
    }
    const trips = mergeTripsWithPayrollLocks(
      active.state.trips,
      state.trips,
      active.tripMeta,
    );
    persist({
      ...org,
      employees: org.employees.map((employee) =>
        employee.id === active.id
          ? { ...employee, state: { ...state, trips }, tripMeta }
          : employee,
      ),
    });
  };

  const updateEmployeeExpenses = (expenses: Expense[]) => {
    if (!active) return;
    const expenseMeta = { ...active.expenseMeta };
    const merged = mergeExpensesWithPayrollLocks(
      active.expenses,
      expenses,
      expenseMeta,
    );
    for (const item of merged) {
      if (!expenseMeta[item.id]) {
        expenseMeta[item.id] = { processed: false, paid: false };
      }
    }
    for (const id of Object.keys(expenseMeta)) {
      if (!merged.some((item) => item.id === id)) {
        delete expenseMeta[id];
      }
    }
    persist({
      ...org,
      employees: org.employees.map((employee) =>
        employee.id === active.id
          ? { ...employee, expenses: merged, expenseMeta }
          : employee,
      ),
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar demo-topbar">
        <Brand />
        <div className="demo-banner" role="status">
          Demo preview — no login. Changes save in this browser only.
        </div>
        <div className="demo-controls">
          <ThemePicker />
          <div className="view-toggle" role="tablist" aria-label="Demo view">
            <button
              type="button"
              role="tab"
              aria-selected={view === "employee"}
              className={view === "employee" ? "toggle active" : "toggle"}
              onClick={() => setView("employee")}
            >
              Employee
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "payroll"}
              className={view === "payroll" ? "toggle active" : "toggle"}
              onClick={() => setView("payroll")}
            >
              Payroll
            </button>
          </div>
          {view === "employee" && (
            <>
              <div
                className="view-toggle employee-module-toggle"
                role="tablist"
                aria-label="Employee record type"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={employeeModule === "mileage"}
                  className={
                    employeeModule === "mileage" ? "toggle active" : "toggle"
                  }
                  onClick={() => setEmployeeModule("mileage")}
                >
                  Mileage
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={employeeModule === "expenses"}
                  className={
                    employeeModule === "expenses" ? "toggle active" : "toggle"
                  }
                  onClick={() => setEmployeeModule("expenses")}
                >
                  <Receipt size={14} aria-hidden />
                  Expenses
                </button>
              </div>
              <label className="employee-switch">
                Viewing as
                <select
                  value={active?.id ?? ""}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  {org.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.state.profile?.driverName}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
      </header>

      {view === "employee" && active?.state.profile ? (
        employeeModule === "mileage" ? (
          <Dashboard
            key={`${active.id}-mileage`}
            state={active.state}
            payrollMeta={active.tripMeta}
            onChange={updateEmployeeState}
            storageError={storageError}
          />
        ) : (
          <ExpenseDashboard
            key={`${active.id}-expenses`}
            expenses={active.expenses}
            payrollMeta={active.expenseMeta}
            onChange={updateEmployeeExpenses}
            storageError={storageError}
          />
        )
      ) : (
        <main className="workspace">
          <PayrollDashboard
            org={org}
            onChange={persist}
            onResetDemo={handleReset}
          />
        </main>
      )}
    </div>
  );
}
