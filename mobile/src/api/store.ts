import { views, type ActivityPage, type FixtureClient, type Status, type View } from './types.ts';
import { createFixtureClient, type Scenario } from './fixture-client.ts';
import { DemoError, validatePage, validateStatus } from './validate.ts';

export type Snapshot = { data: ActivityPage; retrievedAt: number };
export type ViewState = { snapshot?: Snapshot; complete?: Snapshot; busy: boolean; stale: boolean; error?: DemoError };
type StatusState = { data?: Status; busy: boolean; error?: DemoError; stale: boolean };
type State = { scenario: Scenario; views: Record<View,ViewState>; status: StatusState; locked?: DemoError; retryUntil: number };
const blank = (): ViewState => ({busy:false,stale:false});
const initialViews = () => Object.fromEntries(views.map(v => [v,blank()])) as Record<View,ViewState>;
const lockedCodes = ['UNAUTHENTICATED','FORBIDDEN','ACCOUNT_UNVERIFIED','ACCOUNT_MISMATCH'];
const asError = (error: unknown) => error instanceof DemoError ? error : new DemoError('PROTOCOL');
const day = (iso: string) => new Date(Date.parse(iso) + 8*3600000).toISOString().slice(0,10);

export function createStore(initialClient?: FixtureClient) {
  let state: State = {scenario:'normal',views:initialViews(),status:{busy:false,stale:false},retryUntil:0};
  let client = initialClient ?? createFixtureClient();
  let epoch = 0, statusRequest = 0;
  const requests: Record<View,number> = {today:0,week:0,pending:0,saved:0};
  const listeners = new Set<() => void>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const set = (next: State) => { state = next; listeners.forEach(fn => fn()); };
  const put = (view: View, value: ViewState) => set({...state,views:{...state.views,[view]:value}});
  function cancel(view: View) {
    requests[view]++;
    const old = state.views[view];
    if (old.busy) put(view,{snapshot:old.complete,complete:old.complete,busy:false,stale:!!old.complete});
  }
  function lock(error: DemoError) {
    epoch++;
    clearTimeout(retryTimer);
    set({...state,views:initialViews(),status:{busy:false,stale:false},locked:error,retryUntil:0});
  }
  function throttle(error: DemoError) {
    if (!error.retryAfter) return;
    const retryUntil = Math.max(state.retryUntil,Date.now()+error.retryAfter*1000);
    clearTimeout(retryTimer);
    set({...state,retryUntil});
    retryTimer = setTimeout(() => set({...state,retryUntil:0}),Math.max(0,retryUntil-Date.now()));
  }
  function setScenario(scenario: Scenario, replacement?: FixtureClient) {
    epoch++; clearTimeout(retryTimer);
    client = replacement ?? createFixtureClient(scenario);
    // Explicit demo reset is the only way out of a simulated authorization lock.
    const reset = scenario === 'normal';
    const nextViews = reset || state.locked ? initialViews() : Object.fromEntries(views.map(v => {
      const complete = state.views[v].complete;
      return [v,{snapshot:complete,complete,busy:false,stale:!!complete}];
    })) as Record<View,ViewState>;
    set({scenario,views:nextViews,status:{data:reset||state.locked?undefined:state.status.data,busy:false,stale:!reset&&!state.locked&&!!state.status.data},
      locked:reset?undefined:state.locked,retryUntil:0});
  }
  async function load(view: View, more = false, limitOverride?: number) {
    const old = state.views[view];
    if (state.locked || state.retryUntil > Date.now() || old.busy) return;
    const previous = more ? old.snapshot : undefined;
    if (more && (!previous || previous.data.page.nextOffset === null || old.stale || old.error)) return;
    const limit = limitOverride ?? (more ? previous!.data.page.limit : ['paging','conflict','conflict-twice','duplicate'].includes(state.scenario)?2:50);
    const ticket = ++requests[view], generation = epoch;
    const valid = () => generation === epoch && requests[view] === ticket;
    put(view,{...old,snapshot:previous ?? old.complete,busy:true,stale:!more&&!!old.complete,error:undefined});
    try {
      let offset = previous?.data.page.nextOffset ?? 0;
      let revision = previous?.data.page.revision;
      let prefix = previous;
      let page: ActivityPage;
      try {
        page = validatePage(await client.activities({view,limit,offset,revision}),{view,limit,offset,revision});
      } catch (error) {
        if (!valid()) return;
        if (asError(error).code !== 'VIEW_CHANGED') throw error;
        // Discard partial prefix, restart once at zero; a second failure is surfaced.
        prefix = undefined; offset = 0; revision = undefined;
        put(view,{snapshot:old.complete,complete:old.complete,busy:true,stale:!!old.complete});
        page = validatePage(await client.activities({view,limit,offset}),{view,limit,offset});
      }
      if (!valid()) return;
      if (prefix) {
        const p = prefix.data;
        if (p.accountId !== page.accountId || p.view !== page.view || p.page.revision !== page.page.revision ||
          p.page.total !== page.page.total || p.items.length !== offset ||
          day(p.evaluatedAt) !== day(page.evaluatedAt) ||
          page.items.some(a => p.items.some(b => b.key === a.key))) throw new DemoError('PROTOCOL');
        page = {...page,items:[...p.items,...page.items],freshness:Date.parse(p.freshness.fetchedAt)<=Date.parse(page.freshness.fetchedAt)?p.freshness:page.freshness};
      }
      if (page.page.nextOffset === null && page.items.length !== page.page.total) throw new DemoError('PROTOCOL');
      const snapshot = {data:page,retrievedAt:Date.now()};
      put(view,{snapshot,complete:page.page.nextOffset===null?snapshot:old.complete,busy:false,stale:false});
    } catch (error) {
      if (!valid()) return;
      const e = asError(error);
      if (lockedCodes.includes(e.code)) { lock(e); return; }
      throttle(e);
      put(view,{snapshot:old.complete,complete:old.complete,busy:false,stale:!!old.complete,error:e});
    }
  }
  async function loadStatus() {
    if (state.locked || state.retryUntil > Date.now() || state.status.busy) return;
    const old = state.status, ticket = ++statusRequest, generation = epoch;
    const valid = () => generation === epoch && ticket === statusRequest;
    set({...state,status:{...old,busy:true,stale:!!old.data,error:undefined}});
    try {
      const data = validateStatus(await client.status());
      if (valid()) set({...state,status:{data,busy:false,stale:false}});
    } catch (error) {
      if (!valid()) return;
      const e = asError(error);
      if (lockedCodes.includes(e.code)) { lock(e); return; }
      throttle(e);
      set({...state,status:{data:old.data,busy:false,stale:!!old.data,error:e}});
    }
  }
  return {getState:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return ()=>{listeners.delete(fn);};},load,loadStatus,cancel,setScenario};
}
export const demo = createStore();
