const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { requiredHeaders } = require("../src/attendance-import");
const { createReportFromCsv } = require("../src/academic-pipeline");
const { createReportHandler, handleMessage, parseCsvLimit } = require("../src/telegram-bot");

const row = ["9001", "SIS-1", "ART 123-X", "Art", "A", "9101", "SIS-A", "8001", "Teacher", "7001", "Student", "2042-03-04", "present", "2042-03-04T01:00:00Z"];
const csv = `${requiredHeaders.join(",")}\n${row.join(",")}\n`;
const dependencies = {
  getProfile: async () => ({ id: 7001 }),
  getAssignments: async () => [{ id: "501", courseId: "9001", course: "ART 123-X", name: "Studio task", submitted: false, excused: false, grade: null }],
};

function fixture(overrides = {}) {
  const sent = [];
  let downloads = 0;
  const telegram = {
    sendMessage: async (id, text) => { sent.push(text); },
    downloadFile: async () => { downloads += 1; return Buffer.from(csv); },
    sendDocument: async (id, buffer) => { sent.push(buffer); },
    ...overrides,
  };
  const reportDocument = createReportHandler({ telegram, createReport: (text) => createReportFromCsv(text, dependencies) });
  return { sent, telegram, reportDocument, getDownloads: () => downloads };
}

const message = { chat: { id: 42, type: "private" }, document: { file_id: "file-1", file_size: Buffer.byteLength(csv), file_name: "../../ignored.csv" } };

test("authorized upload sends a valid workbook from only its CSV", async () => {
  const f = fixture();
  await handleMessage(message, { allowedChatId: 42, reportDocument: f.reportDocument });
  assert.equal(f.getDownloads(), 1);
  const buffer = f.sent.find(Buffer.isBuffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Summary", "Assignments", "Attendance"]);
  assert.equal(workbook.getWorksheet("Attendance").getCell("C2").value, "Present");
  assert.equal(workbook.getWorksheet("Assignments").getCell("B2").value, "Studio task");
  assert.equal(f.sent.at(-1), "Academic report ready.");
});

test("unauthorized and nonprivate uploads never download", async () => {
  const f = fixture();
  await handleMessage(message, { allowedChatId: 99, reportDocument: f.reportDocument });
  await handleMessage({ ...message, chat: { id: 42, type: "group" } }, { allowedChatId: 42, reportDocument: f.reportDocument });
  assert.equal(f.getDownloads(), 0);
  assert.deepEqual(f.sent, []);
});

test("invalid, missing-user, oversized, and failed downloads recover", async () => {
  const f = fixture({ downloadFile: async () => Buffer.from("bad format") });
  await f.reportDocument(message);
  assert.match(f.sent.at(-1), /missing required columns/);
  f.telegram.downloadFile = async () => Buffer.from(csv.replace("7001", "7999"));
  await f.reportDocument(message);
  assert.match(f.sent.at(-1), /No attendance records/);
  await f.reportDocument({ ...message, document: { ...message.document, file_size: 6 * 1024 * 1024 } });
  assert.match(f.sent.at(-1), /size limit/);
  f.telegram.downloadFile = async () => { throw new Error("Telegram file download failed"); };
  await f.reportDocument(message);
  assert.match(f.sent.at(-1), /download failed/);
  f.telegram.downloadFile = async () => Buffer.from(csv);
  await f.reportDocument(message);
  assert.equal(f.sent.at(-1), "Academic report ready.");
});

test("delivery failure gives generic feedback and releases busy guard", async () => {
  const f = fixture({ sendDocument: async () => { throw new Error("private payload"); } });
  await f.reportDocument(message);
  assert.equal(f.sent.at(-1), "Could not generate or deliver the report. Please try again.");
  f.telegram.sendDocument = async () => {};
  await f.reportDocument(message);
  assert.equal(f.sent.at(-1), "Academic report ready.");
});

test("simultaneous reports are rejected without a second download", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture({ downloadFile: async () => { await pending; return Buffer.from(csv); } });
  const first = f.reportDocument(message);
  await f.reportDocument(message);
  assert.match(f.sent.at(-1), /already being generated/);
  release();
  await first;
});

test("CSV limit is configurable within Telegram download limit", () => {
  assert.equal(parseCsvLimit(), 5 * 1024 * 1024);
  assert.equal(parseCsvLimit("2"), 2 * 1024 * 1024);
  assert.throws(() => parseCsvLimit("21"), /integer from 1 to 20/);
});

test("Canvas failures do not end report handling or expose API details", async () => {
  let available = false;
  const f = fixture();
  const reportDocument = createReportHandler({
    telegram: f.telegram,
    createReport: (text) => createReportFromCsv(text, {
      getProfile: async () => {
        if (!available) throw new Error("private Canvas URL and token");
        return { id: 7001 };
      },
      getAssignments: dependencies.getAssignments,
    }),
  });
  await reportDocument(message);
  assert.equal(f.sent.at(-1), "Could not generate or deliver the report. Please try again.");
  available = true;
  await reportDocument(message);
  assert.equal(f.sent.at(-1), "Academic report ready.");
});
