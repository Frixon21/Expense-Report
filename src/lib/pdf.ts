import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  formatDollars,
  formatMiles,
  totalBusinessMiles,
  tripVehicleLabel,
  type MileageState,
  type Trip,
} from "./model";

export type ReportInput = { state: MileageState; from: string; to: string };

function printable(value: string, font: PDFFont) {
  return Array.from(value.replace(/[\r\n\t]/g, " "))
    .map((character) => {
      try {
        font.encodeText(character);
        return character;
      } catch {
        return "?";
      }
    })
    .join("");
}

function wrap(value: string, font: PDFFont, width: number, size: number) {
  const words = printable(value, font).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["—"];
}

async function createVehicleReport({
  state,
  from,
  to,
}: ReportInput): Promise<Uint8Array> {
  if (!state.profile)
    throw new Error(
      "Complete the driver and vehicle profile before exporting a report.",
    );
  if (from > to)
    throw new Error("The report end date must follow its start date.");

  const fullYear =
    from.endsWith("-01-01") && to === `${from.slice(0, 4)}-12-31`;
  const annual = state.annualMileage.find(
    (record) => record.year === Number(from.slice(0, 4)),
  );
  if (
    fullYear &&
    (!annual ||
      annual.opening_tenths === null ||
      annual.closing_tenths === null)
  ) {
    throw new Error(
      "Enter opening and closing odometer readings before exporting a final tax-year report.",
    );
  }

  const trips = state.trips
    .filter((trip) => trip.date >= from && trip.date <= to)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
    );
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.14, 0.24);
  const blue = rgb(0.12, 0.33, 0.76);
  const rule = rgb(0.84, 0.88, 0.94);
  let page!: PDFPage;
  let y = 0;

  const drawText = (
    value: string,
    x: number,
    atY: number,
    size = 8,
    strong = false,
  ) =>
    page.drawText(printable(value, strong ? bold : font), {
      x,
      y: atY,
      size,
      font: strong ? bold : font,
      color: ink,
    });
  const tableHeader = () => {
    page.drawRectangle({
      x: 30,
      y: y - 5,
      width: 552,
      height: 22,
      color: blue,
    });
    const labels = [
      "Date",
      "Destination",
      "Business purpose",
      "Start",
      "End",
      "Miles",
      "Parking",
      "Tolls",
    ];
    const xs = [36, 91, 188, 343, 389, 435, 477, 528];
    labels.forEach((label, index) =>
      page.drawText(label, {
        x: xs[index],
        y,
        size: 7,
        font: bold,
        color: rgb(1, 1, 1),
      }),
    );
    y -= 27;
  };
  const newPage = (first = false) => {
    page = pdf.addPage([612, 792]);
    y = 758;
    if (!first) {
      drawText(`${state.profile!.businessName} — Mileage log`, 30, y, 10, true);
      y -= 26;
      tableHeader();
    }
  };

  newPage(true);
  drawText(state.profile.businessName.toUpperCase(), 30, y, 10, true);
  y -= 31;
  drawText("Business mileage log", 30, y, 23, true);
  y -= 27;
  drawText(
    `${state.profile.driverName}  |  ${state.profile.vehicleDescription}`,
    30,
    y,
    10,
    true,
  );
  y -= 16;
  drawText(
    `Vehicle first used for business: ${state.profile.businessUseStartDate}`,
    30,
    y,
  );
  y -= 15;
  drawText(`Report period: ${from} through ${to} (inclusive)`, 30, y);
  y -= 21;
  const parking = trips.reduce((sum, trip) => sum + trip.parking_cents, 0);
  const tolls = trips.reduce((sum, trip) => sum + trip.tolls_cents, 0);
  drawText(
    `Business miles: ${formatMiles(totalBusinessMiles(trips))}   Trips: ${trips.length}   Parking: ${formatDollars(parking)}   Tolls: ${formatDollars(tolls)}`,
    30,
    y,
    10,
    true,
  );
  y -= 20;
  if (annual) {
    const opening =
      annual.opening_tenths === null
        ? "Not entered"
        : formatMiles(annual.opening_tenths);
    const closing =
      annual.closing_tenths === null
        ? "Not entered"
        : formatMiles(annual.closing_tenths);
    const total =
      annual.opening_tenths !== null && annual.closing_tenths !== null
        ? formatMiles(annual.closing_tenths - annual.opening_tenths)
        : "Incomplete";
    drawText(
      `${annual.year} total vehicle mileage: ${total}   Opening odometer: ${opening}   Closing/current odometer: ${closing}`,
      30,
      y,
    );
    y -= 22;
  }
  tableHeader();

  if (!trips.length)
    drawText("No business trips recorded in this date range.", 36, y - 8, 9);
  for (const trip of trips) {
    const destination = wrap(trip.destination, font, 90, 7);
    const purpose = wrap(
      trip.businessPurpose +
        (trip.vehicleName &&
        trip.vehicleName !== state.profile.vehicleDescription
          ? ` [Vehicle recorded: ${trip.vehicleName}]`
          : ""),
      font,
      148,
      7,
    );
    const height = Math.max(
      26,
      Math.max(destination.length, purpose.length) * 10 + 9,
    );
    if (y - height < 48) newPage();
    const values = [
      trip.date,
      formatMiles(trip.start_tenths),
      formatMiles(trip.end_tenths),
      formatMiles(trip.end_tenths - trip.start_tenths),
      trip.parking_cents ? formatDollars(trip.parking_cents) : "—",
      trip.tolls_cents ? formatDollars(trip.tolls_cents) : "—",
    ];
    drawText(values[0], 36, y - 3, 7);
    destination.forEach((line, index) =>
      drawText(line, 91, y - 3 - index * 10, 7),
    );
    purpose.forEach((line, index) =>
      drawText(line, 188, y - 3 - index * 10, 7),
    );
    [343, 389, 435, 477, 528].forEach((x, index) =>
      drawText(values[index + 1], x, y - 3, 7),
    );
    y -= height;
    page.drawLine({
      start: { x: 30, y: y + 7 },
      end: { x: 582, y: y + 7 },
      thickness: 0.5,
      color: rule,
    });
  }

  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    current.drawText(
      `Generated ${new Date().toISOString().slice(0, 10)} | Page ${index + 1} of ${pages.length}`,
      {
        x: 30,
        y: 23,
        size: 7,
        font,
        color: ink,
      },
    );
    current.drawText(
      "Keep with supporting business records. Recordkeeping fields follow IRS Publication 463.",
      {
        x: 250,
        y: 23,
        size: 7,
        font,
        color: ink,
      },
    );
  });
  return pdf.save();
}

/** Separate vehicle summaries prevent mixing odometer readings from different cars. */
export async function createReport(input: ReportInput): Promise<Uint8Array> {
  const { state, from, to } = input;
  if (!state.profile || !state.vehicles?.length)
    return createVehicleReport(input);
  const included = state.trips.filter((t) => t.date >= from && t.date <= to);
  const ids = [
    ...new Set(included.map((t) => t.vehicleId ?? state.defaultVehicleId)),
  ];
  if (!ids.length) ids.push(state.defaultVehicleId);
  const output = await PDFDocument.create();
  for (const id of ids) {
    const trips = included.filter(
      (t) => (t.vehicleId ?? state.defaultVehicleId) === id,
    );
    const vehicle = state.vehicles.find((v) => v.id === id);
    const first = trips[0];
    const description = first
      ? tripVehicleLabel(state, first)
      : (vehicle?.description ?? "Legacy vehicle needs review");
    const bytes = await createVehicleReport({
      ...input,
      state: {
        ...state,
        profile: {
          ...state.profile,
          vehicleDescription: description,
          businessUseStartDate:
            first?.vehicleBusinessUseStartDate ??
            vehicle?.businessUseStartDate ??
            "Unknown - review legacy profile",
        },
        trips,
        annualMileage: state.annualMileage.filter(
          (a) => (a.vehicleId ?? state.defaultVehicleId) === id,
        ),
      },
    });
    const doc = await PDFDocument.load(bytes);
    for (const page of await output.copyPages(doc, doc.getPageIndices()))
      output.addPage(page);
  }
  return output.save();
}
