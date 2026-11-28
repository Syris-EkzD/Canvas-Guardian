import { ACCOUNT, CLOCK, type Activity, type ActivityPage, type FixtureClient, type Query, type Result, type View } from './types.ts';
import { DemoError } from './validate.ts';

export const scenarios = ['normal','paging','empty','cached','conflict','conflict-twice','upstream','status-error','offline','rate-limit','unauthenticated','forbidden','account-unverified','account-mismatch','invalid','duplicate','slow'] as const;
export type Scenario = typeof scenarios[number];
const row = (assignmentId: string, courseId: string, courseName: string, title: string, dueAt: string | null, guardianStatus: Activity['guardianStatus'] = 'pending'): Activity => ({
  key: courseId + ':' + assignmentId, courseId, assignmentId, courseName, title, dueAt,
  canvasUrl: assignmentId === '104' ? null : 'https://canvas.example.edu/courses/' + courseId + '/assignments/' + assignmentId,
  guardianStatus, submitted: false,
});
const rows = [
  row('101','42','NET101','Worksheet','2026-11-27T15:59:00.000Z'),
  row('102','43','DB101','Exercise','2026-11-27T00:00:00.000Z'),
  row('103','42','NET101','Worksheet','2026-11-26T12:00:00.000Z'),
  row('104','43','DB101','Long activity title for checking wrapping and large text without a scheduled deadline',null),
  row('105','42','NET101','Network lab','2026-12-04T11:00:00.000Z'),
  row('106','43','DB101','Database lab','2026-12-04T11:00:00.001Z'),
  row('107','42','NET101','Reading','2026-11-27T15:59:00.000Z','dismissed'),
  row('108','43','DB101','Offline practice','2026-11-28T11:00:00.000Z','completed_offline'),
];
const ids: Record<View,string[]> = {pending:['103','102','101','105','106','104'],today:['102','101'],week:['101','105'],saved:['107','108']};
// Precomputed SHA-256(JSON.stringify([ACCOUNT, view, ordered projected items])).
// Regression test recomputes using Node crypto; runtime has no crypto dependency.
const revisions: Record<View,[string,string]> = {
  pending:['0d4b8e5e976aa8ae4702f1f4b75d9e2cda0eef58ac9532f3589d750193d3309b','1cc857a02d6d526421edef615406df2269462f5a51589d1fb20748336819060d'],
  today:['2d50d6cdcfedaecf7c733ba0ffbfe7deddfdefaf4b02e593eb510648bcc0671a','1e76a6649e2d30d15c0b5974e1f4b0941d4e3efccd31eabb31902ee089959939'],
  week:['206af6d2c95b27b5e3f2116adcf6ced1a67c4f165dba790b85a3c7e5d8f88abc','5faae1946bce1e819baa6f781dff49de27d4f6d83608f452cc5b2027e814516d'],
  saved:['4e76f2cd30f27266fa0a7781efbdd356df56e8b6abc76462deae7ed5212f552c','376d68d5f18d6a350dc921d4d2d67011be816b9666a56c3c9c63d307d548da15'],
};
const changedRevision = 'de5b3745474e1c51f8d1501b970b3ab0ece3bd501c178ee8da4d379e32d2bd46';
const error = (status: number, code: string, retryAfter?: number): Result => ({
  status, body:{error:{code,message:'Synthetic fixture response',requestId:'demo-' + code.toLowerCase().replaceAll('_','-')}},retryAfter,
});
export function createFixtureClient(scenario: Scenario = 'normal', delay = 180): FixtureClient {
  let changed = false, limited = false;
  const wait = () => new Promise<void>(resolve => setTimeout(resolve, scenario === 'slow' ? delay * 10 : delay));
  function denial(): Result | undefined {
    if (scenario === 'unauthenticated') return error(401,'UNAUTHENTICATED');
    if (scenario === 'forbidden') return error(403,'FORBIDDEN');
    if (scenario === 'account-unverified') return error(503,'ACCOUNT_UNVERIFIED');
    if (scenario === 'offline') throw new DemoError('OFFLINE');
    return undefined;
  }
  return {
    async activities(q: Query) {
      await wait();
      const denied = denial(); if (denied) return denied;
      if (scenario === 'upstream') return error(502,'UPSTREAM_FAILED');
      if (scenario === 'rate-limit' && !limited) { limited = true; return error(429,'RATE_LIMITED',3); }
      if (scenario === 'invalid') return {status:200,body:{accountId:ACCOUNT,items:'invalid'}};
      if (!(q.view in ids) || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100 || !Number.isInteger(q.offset) || q.offset < 0 || q.offset > 10000 ||
        (q.offset > 0 && !q.revision) || (q.revision !== undefined && !/^[a-f0-9]{64}$/.test(q.revision))) return error(400,'INVALID_QUERY');
      if (q.view === 'pending' && (scenario === 'conflict' || scenario === 'conflict-twice') && q.offset > 0 && !changed) {
        changed = true; return error(409,'VIEW_CHANGED');
      }
      if (scenario === 'conflict-twice' && changed && q.view === 'pending') return error(409,'VIEW_CHANGED');
      const empty = scenario === 'empty';
      const changedPending = changed && q.view === 'pending';
      const all = (empty ? [] : ids[q.view].filter(id => !changedPending || id !== '103')).map(id => rows.find(r => r.assignmentId === id)!);
      const revision = changedPending ? changedRevision : revisions[q.view][empty ? 1 : 0];
      if (q.revision && q.revision !== revision) return error(409,'VIEW_CHANGED');
      const items = all.slice(q.offset,q.offset + q.limit).map(item => ({...item}));
      if (scenario === 'duplicate' && q.offset > 0 && items.length && all.length) items[0] = {...all[0]};
      const data: ActivityPage = {
        accountId: scenario === 'account-mismatch' ? '00000000-0000-4000-8000-000000000002' : ACCOUNT,
        view:q.view, timezone:'Asia/Manila',evaluatedAt:CLOCK,
        freshness:{source:'canvas',fetchedAt:scenario === 'normal' ? CLOCK : '2026-11-27T10:59:50.000Z',ageSeconds:scenario === 'normal' ? 0 : 10,maxAgeSeconds:60,state:scenario === 'normal' ? 'fresh' : 'cached'},
        page:{limit:q.limit,offset:q.offset,total:all.length,nextOffset:q.offset+items.length<all.length?q.offset+items.length:null,revision},items,
      };
      return {status:200,body:data};
    },
    async status() {
      await wait(); const denied = denial(); if (denied) return denied;
      if (scenario === 'status-error') return error(503,'SERVICE_UNAVAILABLE');
      return {status:200,body:{accountId:scenario === 'account-mismatch'?'00000000-0000-4000-8000-000000000002':ACCOUNT,timezone:'Asia/Manila',monitoring:'running',calendarSyncEnabled:true,scheduleConfiguredMinutes:10,runtimeHealth:'unverified'}};
    },
  };
}
