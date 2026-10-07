# Changelog

This project tracks meaningful release milestones rather than dumping commit history.

## [0.3.0]

Canvas Guardian 0.3.0 is the first deliberately tracked modern release line of the project.

### Added

- Shared Canvas HTTP and assignment-normalization infrastructure.
- Deterministic automated tests and GitHub Actions CI.
- Academic Data Pipeline MVP combining live Canvas assignments with official offline Roll Call CSV exports.
- Multi-file Roll Call attendance ingestion with current-user filtering and overlap deduplication.
- Excel academic report generation with Summary, Assignments, and Attendance sheets.
- Runtime configuration validation with explicit missing-variable errors.
- Shared Telegram HTTP client.
- Small runtime reliability helpers for pending activity rules and Manila date selection.
- Regression coverage for runtime import safety.

### Changed

- Guardian consumers retrieve complete Canvas collections through paginated reads where completeness is required.
- Executable runtime modules are safe to import without starting services or opening the production runtime database.
- Pending assignment handling treats an activity as excused only when Canvas reports `excused === true`.
- Package metadata now reflects the self-hosted application and the `0.3.0` release line.

### Security and reliability

- Canvas pagination rejects foreign-origin continuation URLs before forwarding the Canvas access token.
- Attendance exports, generated academic reports, OAuth material, environment files, and local databases remain excluded from Git.
- Runtime services validate only the configuration they require at startup.
- Telegram HTTP failures and Telegram API error payloads are handled consistently.

## v0.2.0-calendar-stable - documented historical milestone

`v0.2.0-calendar-stable` was used in project documentation as the previous stable milestone for the original Guardian runtime, including Canvas monitoring, Telegram commands, and Google Calendar synchronization.

It was **not** created as a Git tag or GitHub Release, so this changelog records it as a documented historical milestone rather than claiming a GitHub release artifact exists.
