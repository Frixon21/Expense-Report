# Biztech Mileage Log

A browser-only mileage log for recording business vehicle use. There are no accounts, server APIs, or database. Driver details and trips are saved in the current browser's local storage.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:3000`.

## Data and backups

All records stay in the browser profile on the current device. Clearing site data, using private browsing, changing browsers, or losing the device can erase the log. Use **Download backup** regularly and keep the JSON backup and periodic PDF reports with the business's tax records. **Restore backup** validates a previously downloaded backup before replacing the current browser data.

## Recordkeeping fields

Each trip records the date, business destination or area, business purpose, starting and ending odometer readings, and optional parking and tolls. The profile records the driver, vehicle, and date the vehicle was first used for business. Biztech is used as the internal business name on reports and backups. Annual opening and closing/current odometer readings establish total vehicle mileage for the year; both are required before exporting a final full-year report.

These fields follow the vehicle-expense recordkeeping elements in IRS Publication 463. California Franchise Tax Board guidance generally follows the federal automobile-expense rules and requires adequate records of the date, amount, place, and business character of expenses. The app supports recordkeeping but does not determine whether a trip is deductible or provide tax advice.

Official guidance:

- [IRS Publication 463 — Travel, Gift, and Car Expenses](https://www.irs.gov/publications/p463)
- [California FTB 984 — Business Expenses](https://www.ftb.ca.gov/forms/misc/984.pdf)
- [California FTB — Keeping your tax records](https://www.ftb.ca.gov/file/after-you-file/keeping-your-tax-records.html)

## Verification

```powershell
npm run typecheck
npm run test:coverage
npm run test:e2e
npm run build
```
