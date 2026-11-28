import { ACCOUNT, type ActivityPage, type Query, type Result, type Status } from './types.ts';

export class DemoError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfter?: number;
  constructor(code: string, requestId?: string, retryAfter?: number) {
    super(code); this.code = code; this.requestId = requestId; this.retryAfter = retryAfter;
  }
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const integer = (x: unknown, low: number, high: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= low && x <= high;
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const iso = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const id = (x: unknown): x is string => typeof x === 'string' && /^[1-9]\d*$/.test(x);
const protocol = (): never => { throw new DemoError('PROTOCOL'); };
const codes: Record<number, string[]> = {
  400: ['INVALID_QUERY','INVALID_REQUEST'], 401: ['UNAUTHENTICATED'], 403: ['FORBIDDEN'],
  404: ['NOT_FOUND'], 405: ['METHOD_NOT_ALLOWED'], 409: ['VIEW_CHANGED'],
  429: ['RATE_LIMITED'], 500: ['INTERNAL_ERROR'], 502: ['UPSTREAM_INVALID','UPSTREAM_FAILED'],
  503: ['SERVICE_UNAVAILABLE','ACCOUNT_UNVERIFIED'], 504: ['UPSTREAM_TIMEOUT'],
};
function body(result: Result): Record<string, unknown> {
  if (result.status !== 200) {
    if (result.status === 408 || result.status === 431) throw new DemoError('PROTOCOL');
    const b = result.body;
    if (record(b) && exact(b, ['error']) && record(b.error) &&
        exact(b.error, ['code','message','requestId']) && nonempty(b.error.code) &&
        nonempty(b.error.message) && typeof b.error.requestId === 'string' &&
        /^[a-zA-Z0-9-]{1,80}$/.test(b.error.requestId) &&
        codes[result.status]?.includes(b.error.code)) {
      if (result.status === 429 && !integer(result.retryAfter, 1, 3600)) return protocol();
      throw new DemoError(b.error.code, b.error.requestId,
        integer(result.retryAfter, 1, 3600) ? result.retryAfter : undefined);
    }
    // Even a malformed authorization denial must invalidate local data.
    if (result.status === 401 || result.status === 403) throw new DemoError(result.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN');
    return protocol();
  }
  if (!record(result.body)) return protocol();
  if (result.body.accountId !== ACCOUNT) throw new DemoError('ACCOUNT_MISMATCH');
  return result.body;
}
function safeUrl(x: unknown, course: string, assignment: string): boolean {
  // The demo origin is fixed; no URL is opened.
  return x === null || x === 'https://canvas.example.edu/courses/' + course + '/assignments/' + assignment;
}
export function validatePage(result: Result, query: Query): ActivityPage {
  const b = body(result);
  if (!exact(b,['accountId','view','timezone','evaluatedAt','freshness','page','items']) ||
      b.view !== query.view || b.timezone !== 'Asia/Manila' || !iso(b.evaluatedAt)) return protocol();
  const f = b.freshness, p = b.page, items = b.items;
  if (!record(f) || !exact(f,['source','fetchedAt','ageSeconds','maxAgeSeconds','state']) ||
      f.source !== 'canvas' || !iso(f.fetchedAt) || Date.parse(f.fetchedAt) > Date.parse(b.evaluatedAt) ||
      !integer(f.ageSeconds,0,60) || f.maxAgeSeconds !== 60 || (f.state !== 'fresh' && f.state !== 'cached')) return protocol();
  if (!record(p) || !exact(p,['limit','offset','total','nextOffset','revision']) ||
      !integer(p.limit,1,100) || p.limit !== query.limit || !integer(p.offset,0,10000) || p.offset !== query.offset ||
      !integer(p.total,0,10000) || typeof p.revision !== 'string' || !/^[a-f0-9]{64}$/.test(p.revision) ||
      (query.revision !== undefined && p.revision !== query.revision) || !Array.isArray(items)) return protocol();
  const expected = Math.min(p.limit, Math.max(0,p.total-p.offset));
  if (items.length !== expected || p.nextOffset !== (p.offset + expected < p.total ? p.offset + expected : null)) return protocol();
  const keys = new Set<string>();
  for (const a of items) {
    if (!record(a) || !exact(a,['key','courseId','assignmentId','courseName','title','dueAt','canvasUrl','guardianStatus','submitted']) ||
        !id(a.courseId) || !id(a.assignmentId) || a.key !== a.courseId + ':' + a.assignmentId ||
        !nonempty(a.courseName) || !nonempty(a.title) || (a.dueAt !== null && !iso(a.dueAt)) ||
        !safeUrl(a.canvasUrl,a.courseId,a.assignmentId) || a.submitted !== false ||
        (query.view === 'saved' ? (a.guardianStatus !== 'dismissed' && a.guardianStatus !== 'completed_offline') : a.guardianStatus !== 'pending') ||
        keys.has(a.key as string)) return protocol();
    keys.add(a.key as string);
  }
  return b as unknown as ActivityPage;
}
export function validateStatus(result: Result): Status {
  const b = body(result);
  if (!exact(b,['accountId','timezone','monitoring','calendarSyncEnabled','scheduleConfiguredMinutes','runtimeHealth']) ||
      b.timezone !== 'Asia/Manila' || (b.monitoring !== 'running' && b.monitoring !== 'paused' && b.monitoring !== 'stopped') ||
      typeof b.calendarSyncEnabled !== 'boolean' || b.scheduleConfiguredMinutes !== 10 || b.runtimeHealth !== 'unverified') return protocol();
  return b as unknown as Status;
}
