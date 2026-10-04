# Academic pipeline MVP

The academic pipeline writes one local Excel workbook from live Canvas assignments and the detailed attendance sessions in an official Roll Call export.

```mermaid
flowchart LR
    Env[.env] --> Auth[Canvas authentication]
    Auth --> API[Canvas REST API]
    API --> Canvas[Canvas assignment normalization]
    Canvas --> Activities[Normal academic activities]
    Activities --> Assignments[Assignments sheet]
    Canvas --> CanvasRollCall[Canvas Roll Call assignment]
    CanvasRollCall --> CanvasGrade[Canvas Attendance Grade]
    CanvasGrade --> Summary[Course-level Summary]

    RollCall[Official Roll Call CSV] --> Importer[Attendance importer]
    Importer --> Filter[Current-user filtering]
    Filter --> Attendance[Detailed Attendance sheet]
    Attendance --> Summary

    Assignments --> Output[academic-report.xlsx]
    Attendance --> Output
    Summary --> Output
```

The tested standard Canvas APIs expose Roll Call as an external-tool assignment with an aggregate grade, but not its individual class-date attendance sessions. Those detailed records therefore come from the offline official Roll Call CSV. The importer selects only rows matching the current Canvas profile ID before normalization.

Normal academic activities and attendance remain separate because they represent different record types and granularities. Roll Call is identified from its Instructure external-tool/LTI metadata, not its editable assignment display name. It is excluded from the Assignments sheet and from all academic activity counts, while its exact Canvas grade appears only as Canvas Attendance Grade in Summary. Detailed attendance still comes from official offline Roll Call CSV exports.

The Assignments sheet preserves Canvas Score, Points Possible, and formatted Grade values without calculating percentages or changing their meaning. Detailed Present, Absent, and Late records come only from the offline Roll Call CSV. Courses without detailed offline attendance remain in Summary with blank attendance cells, even when Canvas provides an aggregate Roll Call grade.

Summary includes courses discovered through returned Canvas assignments. Courses with no returned assignments are not added solely for completeness in this MVP.

The raw export contains private educational data and is ignored by Git, as is the generated report. Missing student/date rows are never interpreted as present or absent, and the pipeline does not fabricate attendance records or percentages.

## Local usage

1. Place the official export at `data/input/attendance.csv`.
2. Configure `.env` with `CANVAS_BASE_URL` and `CANVAS_ACCESS_TOKEN`.
3. Run `npm run academic:pipeline`.
4. Open `data/output/academic-report.xlsx`.
