# PR #9 production dependency review

Reviewed on 2026-10-23 with Node.js 24 and `npm audit --omit=dev`. The initial lockfile reported five affected packages: one high and four moderate. `npm ls brace-expansion qs csv-parse exceljs uuid --all` established the paths below.

| Finding | Installed path and exposure | Disposition |
| --- | --- | --- |
| `brace-expansion` 2.1.4, high (three denial of service advisories) | `exceljs` → `archiver` → `readdir-glob` → `minimatch` 5 → `brace-expansion` 2; also `googleapis` → `googleapis-common` → `gaxios` → `rimraf` 5 → `glob` 10 → `minimatch` 9 → `brace-expansion` 2. File globs are internal dependency operations, with no user-supplied pattern identified. | Resolved to 2.1.7 in the existing `^2` ranges. The separate 1.1.21 copies are outside these advisories' affected ranges. |
| `qs` 6.15.3, moderate (array-limit bypass and attacker-controlled `isBuffer` denial of service) | `googleapis` → `googleapis-common` → `qs`. The examined Google API request code uses `qs.stringify` to serialize outbound parameters; the advisories concern parsing attacker-controlled input. | Resolved to 6.16.1 within the existing `^6.7.0` range. |
| `csv-parse` 6.2.1, moderate ([GHSA-8cw4-87c7-c6xx](https://github.com/adaltas/node-csv/security/advisories/GHSA-8cw4-87c7-c6xx)) | Direct dependency; Telegram CSV uploads and offline attendance exports reach `parse` in `src/attendance-import.js`. The vulnerable branch requires **both** `columns: true` and `group_columns_by_name: true`; this importer uses neither and handles header rows and values as arrays. | Accept as currently unreachable and review a major upgrade separately. The patched release is 7.0.2 or later. A temporary 7.0.3 installation preserved the existing attendance import, multi-file, and Telegram report tests, and `require('csv-parse/sync')` remains exported. Those tests do not constitute a full major-version migration review. Do not use `npm audit fix --force` here. |
| `uuid` 8.3.2 and dependent `exceljs` 4.4.0, both moderate ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) | `exceljs` → `uuid`. The advisory concerns `uuid` v3/v5/v6 with caller-supplied output buffers. ExcelJS imports **only v4** in `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js` and calls `uuidv4()` with no arguments. This application creates and writes workbooks. | Accept as unreachable through the current ExcelJS use. ExcelJS 4.4.0 is the current npm release and declares `uuid: ^8.3.0`; a patched `uuid` (at least 11.1.1) is outside that range. Audit proposes ExcelJS 3.4.0, a major downgrade. Do not downgrade ExcelJS or override its incompatible `uuid` range. Revisit when ExcelJS updates its dependency or when a separately reviewed replacement is available. |

The remaining audit findings are dependency presence alerts, not evidence that the affected functions are exercised. Keep the CSV options and ExcelJS call paths in view during future importer or workbook changes. This review does not replace a live Canvas or Telegram integration check before deployment.

## Validation

- `npm ci`: clean installation passed on Node.js 24.15.0.
- `npm test`: passed (Node's reporter counted 13 test files).
- SQLite `:memory:` create, insert, select, and close smoke: passed.
- `npm audit --omit=dev`: three moderate findings remain (`csv-parse`, `uuid`, and the dependent `exceljs` alert); zero high findings. The nonzero audit exit status reflects those documented findings.
