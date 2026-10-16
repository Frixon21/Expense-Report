import type { Expense } from "./expense";
import type { DemoEmployee, DemoOrg } from "./demo-types";
import { defaultTripMeta } from "./demo-types";
import type { MileageState, Trip } from "./model";

const BUSINESS_NAME = "Biztech";

function trip(
  id: string,
  fields: Omit<Trip, "id" | "createdAt"> & { createdAt?: string },
): Trip {
  return {
    id,
    createdAt: fields.createdAt ?? `${fields.date}T17:00:00.000Z`,
    date: fields.date,
    destination: fields.destination,
    businessPurpose: fields.businessPurpose,
    start_tenths: fields.start_tenths,
    end_tenths: fields.end_tenths,
    parking_cents: fields.parking_cents,
    tolls_cents: fields.tolls_cents,
  };
}

function expense(
  id: string,
  fields: Omit<Expense, "id" | "createdAt"> & { createdAt?: string },
): Expense {
  return {
    id,
    createdAt: fields.createdAt ?? `${fields.date}T17:00:00.000Z`,
    ...fields,
  };
}

function employee(
  id: string,
  profile: MileageState["profile"] & object,
  trips: Trip[],
  tripMetaSeed: Record<string, ReturnType<typeof defaultTripMeta>>,
  expenses: Expense[] = [],
  expenseMetaSeed: Record<string, ReturnType<typeof defaultTripMeta>> = {},
): DemoEmployee {
  const tripMeta: DemoEmployee["tripMeta"] = {};
  for (const t of trips) {
    tripMeta[t.id] = tripMetaSeed[t.id] ?? defaultTripMeta();
  }
  const expenseMeta: DemoEmployee["expenseMeta"] = {};
  for (const item of expenses) {
    expenseMeta[item.id] = expenseMetaSeed[item.id] ?? defaultTripMeta();
  }
  return {
    id,
    tripMeta,
    expenses,
    expenseMeta,
    state: {
      version: 1,
      profile: { ...profile, businessName: BUSINESS_NAME },
      annualMileage: [
        {
          year: 2026,
          opening_tenths: trips[0]?.start_tenths ?? 10000,
          closing_tenths: null,
        },
      ],
      trips,
    },
  };
}

export function createDemoOrg(): DemoOrg {
  const alexTrips = [
    trip("a1000001-0001-4001-8001-000000000001", {
      date: "2026-09-28",
      destination: "Sacramento client office",
      businessPurpose: "Network installation",
      start_tenths: 36880,
      end_tenths: 36935,
      parking_cents: 850,
      tolls_cents: 0,
    }),
    trip("a1000001-0001-4001-8001-000000000002", {
      date: "2026-09-30",
      destination: "Fildbrook",
      businessPurpose: "Check on clients along with Kevin during his route",
      start_tenths: 36880,
      end_tenths: 36935,
      parking_cents: 0,
      tolls_cents: 0,
    }),
  ];

  const jordanTrips = [
    trip("b2000002-0002-4002-8002-000000000001", {
      date: "2026-09-12",
      destination: "Eureka",
      businessPurpose: "On-site support visit",
      start_tenths: 45210,
      end_tenths: 45248,
      parking_cents: 0,
      tolls_cents: 450,
    }),
    trip("b2000002-0002-4002-8002-000000000002", {
      date: "2026-09-22",
      destination: "Fortuna",
      businessPurpose: "Equipment delivery",
      start_tenths: 45248,
      end_tenths: 45271,
      parking_cents: 0,
      tolls_cents: 0,
    }),
    trip("b2000002-0002-4002-8002-000000000003", {
      date: "2026-09-29",
      destination: "McKinleyville",
      businessPurpose: "Client training",
      start_tenths: 45271,
      end_tenths: 45295,
      parking_cents: 1200,
      tolls_cents: 0,
    }),
  ];

  const samTrips = [
    trip("c3000003-0003-4003-8003-000000000001", {
      date: "2026-09-05",
      destination: "Oakland",
      businessPurpose: "Quarterly business review",
      start_tenths: 12050,
      end_tenths: 12142,
      parking_cents: 2200,
      tolls_cents: 1850,
    }),
    trip("c3000003-0003-4003-8003-000000000002", {
      date: "2026-09-18",
      destination: "San Jose",
      businessPurpose: "Vendor meeting",
      start_tenths: 12142,
      end_tenths: 12188,
      parking_cents: 1500,
      tolls_cents: 0,
    }),
  ];

  const kevinTrips = [
    trip("d4000004-0004-4004-8004-000000000001", {
      date: "2026-09-30",
      destination: "Humboldt route",
      businessPurpose: "Client route — Fildbrook and surrounding stops",
      start_tenths: 21000,
      end_tenths: 21055,
      parking_cents: 0,
      tolls_cents: 0,
    }),
  ];

  const alexExpenses = [
    expense("a1000001-0001-4001-8001-000000000101", {
      date: "2026-09-25",
      category: "supplies",
      amount: 4299,
      paymentMethod: "personal_card",
      merchant: "Home Depot",
      businessPurpose: "Ethernet and mounting hardware for client install",
      projectOrClient: "Sacramento office",
      notes: "PO #4482",
    }),
    expense("a1000001-0001-4001-8001-000000000102", {
      date: "2026-09-29",
      category: "travel",
      amount: 18900,
      paymentMethod: "company_card",
      merchant: "Marriott Sacramento",
      businessPurpose: "Overnight stay for multi-day client install",
      projectOrClient: "Sacramento office",
    }),
  ];

  const jordanExpenses = [
    expense("b2000002-0002-4002-8002-000000000101", {
      date: "2026-09-14",
      category: "meals",
      amount: 3850,
      paymentMethod: "cash",
      merchant: "Cafe Waterfront",
      businessPurpose: "Client lunch during on-site support",
      projectOrClient: "Eureka account",
      notes: "Attendees: Jordan Lee, client PM",
    }),
    expense("b2000002-0002-4002-8002-000000000102", {
      date: "2026-09-22",
      category: "shipping",
      amount: 2450,
      paymentMethod: "personal_card",
      merchant: "UPS Store",
      businessPurpose: "Rush ship replacement modem to Fortuna client",
      projectOrClient: "Fortuna equipment",
    }),
  ];

  const samExpenses = [
    expense("c3000003-0003-4003-8003-000000000101", {
      date: "2026-09-06",
      category: "meals",
      amount: 5625,
      paymentMethod: "personal_card",
      merchant: "Oakland Grill",
      businessPurpose: "QBR dinner with client stakeholders",
      projectOrClient: "Oakland QBR",
      notes: "Sam Rivera + 3 client attendees",
    }),
    expense("c3000003-0003-4003-8003-000000000102", {
      date: "2026-09-18",
      category: "communications",
      amount: 8900,
      paymentMethod: "company_card",
      merchant: "T-Mobile Business",
      businessPurpose: "Mobile hotspot for vendor demo week",
    }),
  ];

  const kevinExpenses = [
    expense("d4000004-0004-4004-8004-000000000101", {
      date: "2026-09-28",
      category: "client_project",
      amount: 15999,
      paymentMethod: "personal_card",
      merchant: "Amazon Business",
      businessPurpose: "Client-site Wi-Fi access points",
      projectOrClient: "Humboldt route",
    }),
    expense("d4000004-0004-4004-8004-000000000102", {
      date: "2026-09-30",
      category: "supplies",
      amount: 1275,
      paymentMethod: "cash",
      merchant: "AutoZone",
      businessPurpose: "Zip ties and labels for truck inventory",
    }),
  ];

  return {
    version: 2,
    dollarsPerMile: 0.7,
    employees: [
      employee(
        "emp-alex",
        {
          driverName: "Alex Morgan",
          businessName: BUSINESS_NAME,
          vehicleDescription: "2023 Toyota Camry",
          businessUseStartDate: "2024-03-01",
        },
        alexTrips,
        {
          "a1000001-0001-4001-8001-000000000001": {
            processed: true,
            paid: true,
            paidNote: "Sept wk 4",
          },
        },
        alexExpenses,
      ),
      employee(
        "emp-jordan",
        {
          driverName: "Jordan Lee",
          businessName: BUSINESS_NAME,
          vehicleDescription: "2021 Ford Transit",
          businessUseStartDate: "2023-01-15",
        },
        jordanTrips,
        {
          "b2000002-0002-4002-8002-000000000001": {
            processed: true,
            paid: false,
          },
        },
        jordanExpenses,
      ),
      employee(
        "emp-sam",
        {
          driverName: "Sam Rivera",
          businessName: BUSINESS_NAME,
          vehicleDescription: "2024 Honda Civic",
          businessUseStartDate: "2025-06-01",
        },
        samTrips,
        {},
        samExpenses,
      ),
      employee(
        "emp-kevin",
        {
          driverName: "Kevin Nguyen",
          businessName: BUSINESS_NAME,
          vehicleDescription: "2022 Chevy Colorado",
          businessUseStartDate: "2022-11-01",
        },
        kevinTrips,
        {},
        kevinExpenses,
      ),
    ],
  };
}
