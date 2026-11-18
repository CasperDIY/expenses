# Changelog

Versions follow [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
The section of a version becomes the text of its GitHub release.

## [1.0.0] – 2026-11-15

First public release (the project was previously called *Stroški*; its data is used as is).

- Monthly income, bills and savings with "left to spend this month" and "per day"
- Recurring entries (salary, rent, subscriptions) with automatic or manual "paid" confirmation
- Category budgets, savings goals with start month and deadline
- Carry-over between months (can be turned off per month), "move leftover to goal"
- Account balance computed from entries after one bank reconciliation
- Overview charts by month, category and year
- Month management: refresh from templates or delete months
- Excel import (one sheet per month), CSV and JSON export
- Automatic and manual backups with restore
- Slovenian, English and German interface; the language is saved with the data, so every browser and device opens in the language chosen last
- Home Assistant REST endpoint (English keys, Slovenian keys of the old version kept)
- Four editions: Docker (NAS), local file in Chrome/Edge, Google Apps Script (Google Drive), demo
- Optional update check in Settings → Updates; one-click self-update for the Google edition
