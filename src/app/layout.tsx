import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Expense Report | Biztech",
  description:
    "Biztech business mileage and expense records for employees and payroll review.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
