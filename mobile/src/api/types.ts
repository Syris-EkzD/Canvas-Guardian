export const views = ['today', 'week', 'pending', 'saved'] as const;
export type View = typeof views[number];
export type Activity = {
  key: string; courseId: string; assignmentId: string; courseName: string;
  title: string; dueAt: string | null; canvasUrl: string | null;
  guardianStatus: 'pending' | 'dismissed' | 'completed_offline'; submitted: false;
};
export type Freshness = {
  source: 'canvas'; fetchedAt: string; ageSeconds: number; maxAgeSeconds: 60;
  state: 'fresh' | 'cached';
};
export type ActivityPage = {
  accountId: string; view: View; timezone: 'Asia/Manila'; evaluatedAt: string;
  freshness: Freshness;
  page: { limit: number; offset: number; total: number; nextOffset: number | null; revision: string };
  items: Activity[];
};
export type Status = {
  accountId: string; timezone: 'Asia/Manila'; monitoring: 'running' | 'paused' | 'stopped';
  calendarSyncEnabled: boolean; scheduleConfiguredMinutes: 10; runtimeHealth: 'unverified';
};
export type Query = { view: View; limit: number; offset: number; revision?: string };
export type Result = { status: number; body: unknown; retryAfter?: number };
export type FixtureClient = { activities: (query: Query) => Promise<Result>; status: () => Promise<Result> };
export const ACCOUNT = '00000000-0000-4000-8000-000000000001';
export const CLOCK = '2026-11-27T11:00:00.000Z';
