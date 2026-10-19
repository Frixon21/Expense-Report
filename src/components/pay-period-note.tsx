import { paydayForRange } from "@/lib/pay-period";

export default function PayPeriodNote({ from, to, compact = false }: { from: string; to: string; compact?: boolean }) {
  const payday = paydayForRange(from, to);
  if (!payday) return null;
  if (compact) return <p className="payroll-report-payday" role="status">Payday: {payday}.</p>;
  return <div className="pay-period-note" role="status">
    <p>Earning period: {from} to {to}. <strong>Payday: {payday}.</strong></p>
    <small>Current follows the next payday, including payday itself. This schedule is a working assumption.</small>
  </div>;
}
