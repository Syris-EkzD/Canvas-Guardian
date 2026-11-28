import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ACCOUNT} from '../src/api/types.ts';
import {createFixtureClient} from '../src/api/fixture-client.ts';
import {validatePage,validateStatus} from '../src/api/validate.ts';
import {createStore} from '../src/api/store.ts';

const expected={pending:['103','102','101','105','106','104'],today:['102','101'],week:['101','105'],saved:['107','108']};
const q=(view='pending',limit=50,offset=0,revision)=>({view,limit,offset,revision});
for(const [view,ids] of Object.entries(expected))test(view+' fixture parity and revision',async()=>{
  const client=createFixtureClient('normal',0), query=q(view);
  const data=validatePage(await client.activities(query),query);
  assert.deepEqual(data.items.map(x=>x.assignmentId),ids);
  assert.equal(data.page.total,ids.length);
  assert.equal(data.page.revision,createHash('sha256').update(JSON.stringify([ACCOUNT,view,data.items])).digest('hex'));
});
test('same title, different identity, null dates and URL',async()=>{
  const query=q(),data=validatePage(await createFixtureClient('normal',0).activities(query),query);
  assert.equal(data.items[0].title,data.items[2].title);
  assert.notEqual(data.items[0].key,data.items[2].key);
  assert.equal(data.items.at(-1).dueAt,null);assert.equal(data.items.at(-1).canvasUrl,null);
});
test('empty and out-of-range are distinct',async()=>{
  const query=q(),empty=validatePage(await createFixtureClient('empty',0).activities(query),query);
  assert.equal(empty.page.total,0);
  const client=createFixtureClient('normal',0),first=validatePage(await client.activities(query),query);
  const next=q('pending',2,10,first.page.revision),out=validatePage(await client.activities(next),next);
  assert.equal(out.items.length,0);assert.equal(out.page.total,6);
});
test('status independent of activity failure',async()=>{
  const client=createFixtureClient('upstream',0);
  assert.equal(validateStatus(await client.status()).runtimeHealth,'unverified');
  assert.equal((await client.activities(q())).status,502);
});
test('page union and rejection of duplicate across pages',async()=>{
  const store=createStore(createFixtureClient('paging',0));
  await store.load('pending',false,2);await store.load('pending',true);await store.load('pending',true);
  assert.deepEqual(store.getState().views.pending.complete.data.items.map(x=>x.assignmentId),expected.pending);
  store.setScenario('duplicate',createFixtureClient('duplicate',0));
  await store.load('pending',false,2);await store.load('pending',true);
  assert.equal(store.getState().views.pending.error.code,'PROTOCOL');
  assert.equal(store.getState().views.pending.stale,true);
});
test('conflict restarts once at zero; second failure surfaces',async()=>{
  for(const scenario of ['conflict','conflict-twice']){
    const store=createStore();store.setScenario(scenario,createFixtureClient(scenario,0));
    await store.load('pending');await store.load('pending',true);
    const v=store.getState().views.pending;
    if(scenario==='conflict'){assert.equal(v.snapshot.data.page.offset,0);assert.equal(v.snapshot.data.items[0].assignmentId,'102');assert.equal(v.snapshot.data.page.total,5);}
    else {assert.equal(v.error.code,'VIEW_CHANGED');assert.equal(v.snapshot,undefined);}
  }
});
test('offline and malformed data preserve only complete stale snapshot',async()=>{
  const store=createStore(createFixtureClient('normal',0));await store.load('today');
  for(const scenario of ['offline','invalid','upstream']){
    store.setScenario(scenario,createFixtureClient(scenario,0));await store.load('today');
    assert.equal(store.getState().views.today.stale,true);
    assert.equal(store.getState().views.today.snapshot.data.page.total,2);
  }
});
test('authorization or account mismatch clears all views and status',async()=>{
  for(const scenario of ['unauthenticated','forbidden','account-unverified','account-mismatch']){
    const store=createStore(createFixtureClient('normal',0));await store.load('today');await store.loadStatus();
    store.setScenario(scenario,createFixtureClient(scenario,0));await store.load('pending');
    assert.ok(store.getState().locked);assert.equal(store.getState().views.today.snapshot,undefined);
    assert.equal(store.getState().status.data,undefined);
    await store.load('today');assert.equal(store.getState().views.today.snapshot,undefined);
  }
});
test('late response cannot publish after cancellation or scenario switch',async()=>{
  const store=createStore(createFixtureClient('normal',20));
  const pending=store.load('today');store.cancel('today');await pending;
  assert.equal(store.getState().views.today.snapshot,undefined);
  const other=store.load('pending');store.setScenario('empty',createFixtureClient('empty',0));await other;
  assert.equal(store.getState().views.pending.snapshot,undefined);
});
test('rate limit stops subsequent reads before retry window',async()=>{
  const store=createStore(createFixtureClient('rate-limit',0));await store.load('pending');
  assert.equal(store.getState().views.pending.error.code,'RATE_LIMITED');
  assert.ok(store.getState().retryUntil>Date.now());await store.load('today');
  assert.equal(store.getState().views.today.snapshot,undefined);
  store.setScenario('normal',createFixtureClient('normal',0));
});
test('reject malformed DTOs, foreign URL, submitted rows and revision mismatch',async()=>{
  const query=q(),client=createFixtureClient('normal',0);
  for(const corrupt of [
    b=>{b.items[0].canvasUrl='https://foreign.example/';},b=>{b.items[0].submitted=true;},
    b=>{b.items[0].guardianStatus='unknown';},b=>{b.items[0].key='wrong';},
    b=>{b.page.nextOffset=12;},b=>{b.page.revision='bad';},b=>{b.freshness.state='unknown';}
  ]){const result=await client.activities(query);corrupt(result.body);assert.throws(()=>validatePage(result,query),{code:'PROTOCOL'});}
});
test('fixture uses no fetch or XMLHttpRequest',async()=>{
  const oldFetch=globalThis.fetch,oldXHR=globalThis.XMLHttpRequest;let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('network');};globalThis.XMLHttpRequest=function(){calls++;throw Error('network');};
  try{const store=createStore(createFixtureClient('normal',0));await store.load('today');await store.loadStatus();
    assert.equal(store.getState().views.today.snapshot.data.page.total,2);assert.equal(calls,0);
  }finally{globalThis.fetch=oldFetch;globalThis.XMLHttpRequest=oldXHR;}
});
