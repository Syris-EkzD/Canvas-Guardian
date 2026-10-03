# Academic pipeline MVP

The academic pipeline writes one local Excel workbook from live Canvas assignments and the detailed attendance sessions in an official Roll Call export.

```mermaid
flowchart LR
    Env[.env] --> Auth[Canvas authentication]
    Auth --> API[Canvas REST API]
    API --> Canvas[Canvas normalization]
    Canvas --> Assignments[Assignments sheet]

    RollCall[Official Roll Call CSV] --> Importer[Attendance importer]
    Importer --> Filter[Current-user filtering]
    Filter --> Attendance[Attendance sheet]

    Assignments --> Summary[Course-level Summary]
    Attendance --> Summary

    Assignments --> Output[academic-report.xlsx]
    Attendance --> Output
    Summary --> Output
```

The tested standard Canvas APIs expose Roll Call as an external-tool assignment with an aggregate grade, but not its individual class-date attendance sessions. Those detailed records therefore come from the offline official Roll Call CSV. The importer selects only rows matching the current Canvas profile ID before normalization.

Assignments and attendance remain separate sheets because an assignment row and a class attendance row represent different record types and granularities. They meet only in the course-level Summary sheet. Courses without detailed attendance remain in Summary with blank attendance cells.

The raw export contains private educational data and is ignored by Git, as is the generated report. Missing student/date rows are never interpreted as present or absent, and the pipeline does not fabricate attendance records or percentages.

## Local usage

1. Place the official export at `data/input/attendance.csv`.
2. Configure `.env` with `CANVAS_BASE_URL` and `CANVAS_ACCESS_TOKEN`.
3. Run `npm run academic:pipeline`.
4. Open `data/output/academic-report.xlsx`.
