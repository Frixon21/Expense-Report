import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import {
  employeeExpenseMeta,
  employeeTripMeta,
  tripReimbursement,
  type DemoEmployee,
} from "./demo-types";
import {
  categoryLabel,
  expenseReimbursableCents,
  formatExpenseAmount,
  paymentMethodLabel,
} from "./expense";
import { formatDollars, formatMiles, totalBusinessMiles } from "./model";
import { payrollLinesForEmployee, type PayrollLine } from "./payroll-lines";

export type PayrollReportInput = {
  employee: DemoEmployee;
  from: string;
  to: string;
  dollarsPerMile: number;
  tripRatesCentsPerMile?: Record<string, number>;
};

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
  const words = printable(value, font)
    .split(/\s+/)
    .flatMap((word) => {
      const chunks: string[] = [];
      let chunk = "";
      for (const character of word) {
        if (chunk && font.widthOfTextAtSize(chunk + character, size) > width) {
          chunks.push(chunk);
          chunk = "";
        }
        chunk += character;
      }
      if (chunk) chunks.push(chunk);
      return chunks;
    });
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

function lineDescription(line: PayrollLine) {
  if (line.kind === "mileage") {
    return `${line.trip.destination} — ${line.trip.businessPurpose}`;
  }
  const expense = line.expense;
  return `${expense.merchant} — ${categoryLabel(expense.category)} — ${expense.businessPurpose}`;
}

function lineAmount(
  line: PayrollLine,
  dollarsPerMile: number,
  tripRatesCentsPerMile: Record<string, number> = {},
): { primary: string; parkingTolls: string } {
  if (line.kind === "mileage") {
    const trip = line.trip;
    const rate = tripRatesCentsPerMile[trip.id];
    const mileagePay = rate === undefined
      ? tripReimbursement(trip, dollarsPerMile)
      : ((trip.end_tenths - trip.start_tenths) / 10) * (rate / 100);
    const parkingTolls = trip.parking_cents + trip.tolls_cents;
    return {
      primary: formatDollars(Math.round(mileagePay * 100)),
      parkingTolls: parkingTolls ? formatDollars(parkingTolls) : "—",
    };
  }
  const reimb = expenseReimbursableCents(line.expense);
  return {
    primary: formatExpenseAmount(reimb > 0 ? reimb : line.expense.amount),
    parkingTolls: paymentMethodLabel(line.expense.paymentMethod),
  };
}

function lineStatus(employee: DemoEmployee, line: PayrollLine) {
  const meta =
    line.kind === "mileage"
      ? employeeTripMeta(employee, line.trip.id)
      : employeeExpenseMeta(employee, line.expense.id);
  const flags = [
    meta.processed ? "Processed" : "Open",
    meta.paid ? "Paid" : "Unpaid",
  ];
  return flags.join(" / ");
}

export async function createPayrollEmployeeReport({
  employee,
  from,
  to,
  dollarsPerMile,
  tripRatesCentsPerMile = {},
}: PayrollReportInput): Promise<Uint8Array> {
  if (from > to)
    throw new Error("The report end date must follow its start date.");

  const profile = employee.state.profile;
  if (!profile)
    throw new Error("This employee does not have a profile on file.");

  const lines = payrollLinesForEmployee(
    employee.state.trips,
    employee.expenses,
    from,
    to,
  );
  const visibleTrips = lines
    .filter((line) => line.kind === "mileage")
    .map((line) => line.trip);
  const visibleExpenses = lines
    .filter((line) => line.kind === "expense")
    .map((line) => line.expense);

  const miles = totalBusinessMiles(visibleTrips);
  const mileagePay = visibleTrips.reduce(
    (sum, trip) => {
      const rate = tripRatesCentsPerMile[trip.id];
      return sum + (rate === undefined
        ? tripReimbursement(trip, dollarsPerMile)
        : ((trip.end_tenths - trip.start_tenths) / 10) * (rate / 100));
    },
    0,
  );
  const parkingTolls = visibleTrips.reduce(
    (sum, trip) => sum + trip.parking_cents + trip.tolls_cents,
    0,
  );
  const expenseReimburse = visibleExpenses.reduce(
    (sum, item) => sum + expenseReimbursableCents(item),
    0,
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

  const COL = {
    date: 36,
    type: 90,
    desc: 134,
    descWidth: 224,
    start: 366,
    end: 430,
    miles: 494,
    amount: 540,
    extra: 600,
    status: 680,
  };

  const tableHeader = () => {
    const headerHeight = 34;
    const gapAbove = 18;
    y -= gapAbove;
    const headerBottom = y - headerHeight;
    page.drawRectangle({
      x: 30,
      y: headerBottom,
      width: 732,
      height: headerHeight,
      color: blue,
    });
    const topY = headerBottom + headerHeight - 11;
    const subY = headerBottom + 10;
    const drawHeader = (text: string, x: number, baseline: number) =>
      page.drawText(text, {
        x,
        y: baseline,
        size: 7,
        font: bold,
        color: rgb(1, 1, 1),
      });
    drawHeader("Date", COL.date, topY);
    drawHeader("Type", COL.type, topY);
    drawHeader("Description", COL.desc, topY);
    drawHeader("Odo start", COL.start, topY);
    drawHeader("Odo end", COL.end, topY);
    drawHeader("Trip miles", COL.miles, topY);
    drawHeader("Amount", COL.amount, topY);
    drawHeader("Parking /", COL.extra, topY);
    drawHeader("pay method", COL.extra, subY);
    drawHeader("Payroll", COL.status, topY);
    drawHeader("status", COL.status, subY);
    y = headerBottom - 12;
  };

  const newPage = (first = false) => {
    page = pdf.addPage([792, 612]);
    y = 578;
    if (!first) {
      drawText(`${profile.businessName} — Payroll summary`, 30, y, 10, true);
      y -= 26;
      tableHeader();
    }
  };

  newPage(true);
  drawText(profile.businessName.toUpperCase(), 30, y, 10, true);
  y -= 28;
  drawText("Payroll reimbursement summary", 30, y, 20, true);
  y -= 26;
  drawText(
    `${profile.driverName}  |  ${profile.vehicleDescription}`,
    30,
    y,
    10,
    true,
  );
  y -= 16;
  drawText(`Report period: ${from} through ${to} (inclusive)`, 30, y);
  y -= 15;
  drawText(
    Object.keys(tripRatesCentsPerMile).length
      ? "Mileage rate: saved processed rates, current dated rate for new claims"
      : `Mileage rate: $${dollarsPerMile.toFixed(2)}/mi`,
    30,
    y,
  );
  y -= 18;
  drawText(
    `Business miles: ${formatMiles(miles)}   Est. mileage pay: ${formatDollars(Math.round(mileagePay * 100))}`,
    30,
    y,
    9,
    true,
  );
  y -= 13;
  drawText(
    `Parking/tolls: ${formatDollars(parkingTolls)}   Expense reimburse: ${formatExpenseAmount(expenseReimburse)}`,
    30,
    y,
    9,
    true,
  );
  y -= 20;
  tableHeader();

  if (!lines.length) {
    drawText("No mileage or expenses in this date range.", 36, y - 8, 9);
  }

  for (const line of lines) {
    const description = wrap(lineDescription(line), font, COL.descWidth, 7);
    const amounts = lineAmount(line, dollarsPerMile, tripRatesCentsPerMile);
    const status = wrap(lineStatus(employee, line), font, 78, 7);
    const extras = wrap(amounts.parkingTolls, font, 72, 7);
    const height = Math.max(
      26,
      Math.max(description.length, status.length, extras.length) * 10 + 9,
    );
    if (y - height < 48) newPage();
    drawText(line.date, COL.date, y - 3, 7);
    drawText(
      line.kind === "mileage" ? "Mileage" : "Expense",
      COL.type,
      y - 3,
      7,
    );
    drawText(
      line.kind === "mileage" ? formatMiles(line.trip.start_tenths) : "—",
      COL.start,
      y - 3,
      7,
    );
    drawText(
      line.kind === "mileage" ? formatMiles(line.trip.end_tenths) : "—",
      COL.end,
      y - 3,
      7,
    );
    drawText(
      line.kind === "mileage"
        ? formatMiles(line.trip.end_tenths - line.trip.start_tenths)
        : "—",
      COL.miles,
      y - 3,
      7,
    );
    drawText(amounts.primary, COL.amount, y - 3, 7);
    extras.forEach((text, index) =>
      drawText(text, COL.extra, y - 3 - index * 10, 7),
    );
    status.forEach((text, index) =>
      drawText(text, COL.status, y - 3 - index * 10, 7),
    );
    // Split exceptionally tall descriptions across pages without repeating pay or distance.
    let remaining = description;
    while (remaining.length) {
      const capacity = Math.max(1, Math.floor((y - 48 - 9) / 10));
      const portion = remaining.slice(0, capacity);
      portion.forEach((text, index) =>
        drawText(text, COL.desc, y - 3 - index * 10, 7),
      );
      remaining = remaining.slice(portion.length);
      y -= Math.max(
        26,
        Math.max(portion.length, status.length, extras.length) * 10 + 9,
      );
      if (remaining.length) newPage();
    }
    page.drawLine({
      start: { x: 30, y: y + 7 },
      end: { x: 762, y: y + 7 },
      thickness: 0.5,
      color: rule,
    });
  }

  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    current.drawText(
      `Generated ${new Date().toISOString().slice(0, 10)} | Page ${index + 1} of ${pages.length}`,
      { x: 30, y: 23, size: 7, font, color: ink },
    );
    current.drawText(
      "Payroll preview export — verify amounts before payment.",
      { x: 250, y: 23, size: 7, font, color: ink },
    );
  });

  return pdf.save();
}
