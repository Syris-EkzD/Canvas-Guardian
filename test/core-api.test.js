const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const Database = require("better-sqlite3");
const { startCoreApi } = require("../src/core-api-main");
const { createCoreApi, createActivityService } = require("../src/core-api");
const { createReadState } = require("../src/core-read-state");
const { readRegistry, bindingOf, createCoreAuth } = require("../src/core-auth");
const { CoreError } = require("../src/core-errors");

const origin = "https://canvas.example.edu";
const now = Date.parse("2026-11-27T11:00:00Z");
const token = Buffer.alloc(32,7).toString("base64url");
const wrong = Buffer.alloc(32,9).toString("base64url");
const accountId = "00000000-0000-4000-8000-000000000001";
const deviceId = "00000000-0000-4000-8000-000000000002";
const hash = token => createHash("sha256").update(token).digest("hex");
const json = data => new Response(JSON.stringify(data));
function fixture(t, candidate = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"guardian-core-"));
  const file = path.join(dir,"registry.json");
  const statePath = path.join(dir,"legacy.db");
  const registry = {version:1,ownerId:"00000000-0000-4000-8000-000000000003",accountId,
    canvasOrigin:origin,canvasProfileId:"99",statePath,legacyOwnershipAttested:true,
    devices:[{deviceId,tokenSha256:hash(token),scopes:["academic:read"],expiresAt:"2026-12-27T11:00:00.000Z",revokedAt:null}]};
  const db = new Database(statePath);
  db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);"+
    "INSERT INTO app_settings VALUES ('monitoring_state','paused'),('calendar_sync_enabled','false'),('telegram_update_offset','55');"+
    "CREATE TABLE activity_status_overrides (assignment_key TEXT PRIMARY KEY,status TEXT NOT NULL CHECK (status IN ('completed_offline','dismissed')),updated_at TEXT NOT NULL);"+
    "CREATE TABLE seen_activities (id TEXT PRIMARY KEY,seen_at TEXT NOT NULL); INSERT INTO seen_activities VALUES ('1','2026-11-26T00:00:00Z');"+
    "CREATE TABLE seen_announcements (id TEXT PRIMARY KEY,seen_at TEXT NOT NULL); INSERT INTO seen_announcements VALUES ('2','2026-11-26T00:00:00Z');"+
    "CREATE TABLE deadline_reminders (assignment_key TEXT NOT NULL,due_at TEXT NOT NULL,reminder_type TEXT NOT NULL,sent_at TEXT NOT NULL,PRIMARY KEY(assignment_key,due_at,reminder_type));"+
    "INSERT INTO deadline_reminders VALUES ('42:101','2026-11-27T15:59:00Z','24h','2026-11-26T00:00:00Z');"+
    "CREATE TABLE google_calendar_events (assignment_key TEXT PRIMARY KEY,google_event_id TEXT NOT NULL,due_at TEXT NOT NULL,content_hash TEXT NOT NULL,synced_at TEXT NOT NULL);"+
    "INSERT INTO google_calendar_events VALUES ('42:101','event','2026-11-27T15:59:00Z','hash','2026-11-26T00:00:00Z');");
  if (candidate) db.exec(
    "CREATE TABLE ai_chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL);"+
    "INSERT INTO ai_chat_history (chat_id,role,content) VALUES ('42','user','synthetic');"+
    "CREATE TABLE ai_drafts (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,course_id TEXT NOT NULL,assignment_id TEXT NOT NULL,body TEXT NOT NULL,explanation TEXT NOT NULL,gaps_json TEXT NOT NULL,created_at INTEGER NOT NULL);"+
    "INSERT INTO ai_drafts VALUES ('b','42','42','101','synthetic draft','explanation','[]',1);"+
    "CREATE TABLE ai_submissions (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,course_id TEXT NOT NULL,assignment_id TEXT NOT NULL,assignment_title TEXT NOT NULL,submission_type TEXT NOT NULL,payload TEXT NOT NULL,advice TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,destination_json TEXT);"+
    "INSERT INTO ai_submissions VALUES ('a','42','42','101','Worksheet','text','synthetic','advice','uncertain',1,2,'{}'),('c','42','42','101','Worksheet','text','synthetic','advice','reviewed',1,2,'{}'),('d','42','42','101','Worksheet','text','synthetic','advice','staged',1,2,'{}');"+
    "CREATE TABLE ai_setting_confirmations (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,setting TEXT NOT NULL,value TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);"+
    "INSERT INTO ai_setting_confirmations VALUES ('e','42','monitoring','paused','pending',1,2);"+
    "CREATE TABLE ai_working_context (chat_id TEXT PRIMARY KEY,course_id TEXT NOT NULL,assignment_id TEXT NOT NULL,draft_id TEXT);"+
    "INSERT INTO ai_working_context VALUES ('42','42','101','b');");
  const write = () => {
    const temp = file+".tmp";
    fs.writeFileSync(temp,JSON.stringify(registry),{mode:0o600});
    fs.renameSync(temp,file);
  };
  write();
  const snapshot = () => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({name,sql})=>({name,sql,rows:db.prepare("SELECT * FROM "+name+" ORDER BY 1").all()}));
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,statePath,registry,db,write,snapshot};
}
function request(server, target, bearer = token, options = {}) {
  const headers = bearer===null?{}:{Authorization:"Bearer "+bearer};
  return fetch("http://127.0.0.1:"+server.address().port+target,{...options,headers:{...headers,...options.headers}})
    .then(async res=>({status:res.status,headers:res.headers,body:await res.json()}));
}
function upstream() {
  let calls = 0, profileId = 99, fail = false, wait = null;
  const rows = [
    [101,"2026-11-27T15:59:00Z"],[102,"2026-11-27T00:00:00Z"],[103,"2026-11-26T00:00:00Z"],
    [104,null],[105,"2026-12-04T11:00:00Z"],[106,"2026-12-04T11:00:00.001Z"],
    [107,"2026-11-27T12:00:00Z"],[108,"2026-11-27T13:00:00Z"],[109,"2026-11-27T13:00:00Z"],
    [110,"2026-11-27T13:00:00Z"],[111,"2026-11-27T13:00:00Z"],
  ];
  return {get calls(){return calls;}, setProfile(id){profileId=id;},setFail(value){fail=value;},
    setWait(value){wait=value;},fetchImpl:async (url,options)=>{
      calls++; assert.equal(options.method,"GET"); assert.equal(new URL(url).origin,origin);
      const p = new URL(url).pathname;
      if(p.endsWith("/profile")) return json({id:profileId});
      if(fail) return new Response("secret",{status:500});
      if(p==="/api/v1/courses") return json([{id:42,course_code:"NET101"}]);
      if(wait) await wait();
      return json(rows.map(([id,due_at])=>({id,due_at,name:"Worksheet",published:id!==110,
        html_url:origin+"/courses/42/assignments/"+id+"?secret=x",
        submission:id===109?{workflow_state:"submitted"}:id===111?{excused:true}:null})));
    }};
}
async function runtime(t,f,u,clock) {
  const app = await startCoreApi({env:{GUARDIAN_CORE_REGISTRY:f.file,CANVAS_BASE_URL:origin,CANVAS_ACCESS_TOKEN:"synthetic"},
    fetchImpl:u.fetchImpl,now:()=>now,monotonic:()=>clock.tick,port:0});
  t.after(()=>app.stop());
  return app.server;
}
function insertOverride(f,id,status) {
  f.db.prepare("INSERT INTO activity_status_overrides VALUES (?,?,?)").run("42:"+id,status,new Date(now).toISOString());
}
test("real HTTP, exact DTO and pagination parity, fresh/cache, local changes, fail-closed, no writes",async t=>{
  const f=fixture(t),u=upstream(),clock={tick:0};
  insertOverride(f,107,"dismissed");insertOverride(f,108,"completed_offline");insertOverride(f,109,"dismissed");
  const before=f.snapshot();
  const server=await runtime(t,f,u,clock);
  assert.equal(u.calls,1);
  const status=await request(server,"/v1/status");
  assert.deepEqual(status.body,{accountId,timezone:"Asia/Manila",monitoring:"paused",calendarSyncEnabled:false,scheduleConfiguredMinutes:10,runtimeHealth:"unverified"});
  assert.equal(u.calls,1);
  const [a,b]=await Promise.all([request(server,"/v1/activities?limit=2"),request(server,"/v1/activities?limit=2")]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(u.calls,4);
  assert.equal(a.headers.get("cache-control"),"no-store");
  assert.ok([a,b].some(result=>result.body.freshness.state==="fresh"));
  assert.ok([a,b].every(result=>["fresh","cached"].includes(result.body.freshness.state)));
  assert.equal(a.body.page.total,6);assert.equal(a.body.page.nextOffset,2);
  assert.deepEqual(a.body.items[0],{key:"42:103",courseId:"42",assignmentId:"103",courseName:"NET101",title:"Worksheet",
    dueAt:"2026-11-26T00:00:00.000Z",canvasUrl:origin+"/courses/42/assignments/103",guardianStatus:"pending",submitted:false});
  const revision=a.body.page.revision;
  assert.match(revision,/^[a-f0-9]{64}$/);
  const ids=[...a.body.items];
  for(const offset of [2,4]) {
    const page=await request(server,"/v1/activities?limit=2&offset="+offset+"&revision="+revision);
    assert.equal(page.status,200);ids.push(...page.body.items);
  }
  assert.deepEqual(ids.map(x=>x.assignmentId),["103","102","101","105","106","104"]);
  for(const [view,ids] of Object.entries({today:["102","101"],week:["101","105"],saved:["107","108"]})) {
    const result=await request(server,"/v1/activities?view="+view);
    assert.equal(result.status,200);assert.deepEqual(result.body.items.map(x=>x.assignmentId),ids);
  }
  const beyond=await request(server,"/v1/activities?offset=10000&revision="+revision);
  assert.equal(beyond.body.page.total,6);assert.equal(beyond.body.page.nextOffset,null);assert.deepEqual(beyond.body.items,[]);
  assert.deepEqual(f.snapshot(),before);
  insertOverride(f,101,"dismissed");
  assert.equal((await request(server,"/v1/activities?offset=2&revision="+revision)).status,409);
  clock.tick=59999;
  const cached=await request(server,"/v1/activities");
  assert.equal(cached.body.freshness.state,"cached");assert.equal(cached.body.freshness.ageSeconds,59);assert.equal(u.calls,4);
  clock.tick=60000;u.setFail(true);
  const failed=await request(server,"/v1/activities");
  assert.equal(failed.status,502);assert.equal(failed.body.error.code,"UPSTREAM_FAILED");assert.doesNotMatch(JSON.stringify(failed.body),/secret/);
  u.setFail(false);u.setProfile(100);
  assert.equal((await request(server,"/v1/activities")).body.error.code,"ACCOUNT_UNVERIFIED");
  assert.equal((await request(server,"/v1/status")).body.error.code,"ACCOUNT_UNVERIFIED");
});
test("auth denial precedes data, query/method/body errors and registry rotation",async t=>{
  const f=fixture(t),u=upstream(),server=await runtime(t,f,u,{tick:0});
  const before=f.snapshot();
  for(const bearer of [null,"bad",wrong]) {
    const result=await request(server,"/v1/activities",bearer);
    assert.equal(result.status,401);assert.equal(result.headers.get("www-authenticate"),"Bearer");
  }
  f.registry.devices[0].scopes=[];f.write();
  assert.equal((await request(server,"/v1/activities")).status,403);
  f.registry.devices[0].scopes=["academic:read"];
  f.registry.devices[0].expiresAt=new Date(now).toISOString();f.write();
  assert.equal((await request(server,"/v1/activities")).status,401);
  f.registry.devices[0].expiresAt="2026-12-27T11:00:00.000Z";f.registry.devices[0].revokedAt=new Date(now).toISOString();f.write();
  assert.equal((await request(server,"/v1/activities")).status,401);
  f.registry.devices[0].revokedAt=null;f.write();
  for(const query of ["view=x","view=today&view=week","ownerId=x","chatId=42","limit=01","limit=101","offset=1","offset=10001","revision=bad","offset=-1","limit=%FF"]) {
    assert.equal((await request(server,"/v1/activities?"+query)).status,400,query);
  }
  assert.equal((await request(server,"/v1/status?x=y")).status,400);
  assert.equal((await request(server,"/nope")).status,404);
  const method=await request(server,"/v1/status",token,{method:"POST"});
  assert.equal(method.status,405);assert.equal(method.headers.get("allow"),"GET");
  assert.equal((await request(server,"/v1/status",token,{method:"POST",body:"x"})).status,400);
  const dup=await new Promise((resolve,reject)=>{
    const req=http.request({host:"127.0.0.1",port:server.address().port,path:"/v1/status",headers:{Authorization:["Bearer "+token,"Bearer "+token]}},
      res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});req.on("error",reject);req.end();
  });
  assert.equal(dup,401);
  fs.writeFileSync(f.file,"{bad",{mode:0o600});
  assert.equal((await request(server,"/v1/status")).status,503);
  f.write();f.registry.devices[0].tokenSha256=hash(wrong);f.write();
  assert.equal((await request(server,"/v1/status")).status,401);
  assert.equal((await request(server,"/v1/status",wrong)).status,200);
  assert.equal(u.calls,1);assert.deepEqual(f.snapshot(),before);
});
test("revocation during refresh prevents in-flight academic response",async t=>{
  const f=fixture(t),u=upstream();
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  u.setWait(async()=>{entered();await gate;});
  const server=await runtime(t,f,u,{tick:0});
  const pending=request(server,"/v1/activities");
  await started;
  f.registry.devices[0].revokedAt=new Date(now).toISOString();f.write();release();
  const result=await pending;
  assert.equal(result.status,401);assert.equal(result.body.items,undefined);
});
test("bounded rate and response budget, no dispatch after denial",async t=>{
  let count=0;
  const server=createCoreApi({authenticate:header=>{
    if(header!=="Bearer "+token)throw new CoreError("UNAUTHENTICATED");
    return {deviceId,accountId};
  },service:{status(){count++;return {large:"a".repeat(1024*1024)};}},deviceLimit:1,globalLimit:3});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  assert.equal((await request(server,"/v1/status",null)).status,401);
  assert.equal((await request(server,"/v1/status")).status,502);
  const limited=await request(server,"/v1/status");
  assert.equal(limited.status,429);assert.ok(limited.headers.get("retry-after"));
  assert.equal((await request(server,"/v1/status",null)).status,429);
  assert.equal(count,1);
});
test("read-only state defaults, malformed, missing, locked, WAL and candidate evidence",t=>{
  const f=fixture(t),state=createReadState(f.statePath,20);
  const before=f.snapshot();
  assert.equal(state.status().monitoring,"paused");
  assert.deepEqual(f.snapshot(),before);
  f.db.exec("BEGIN EXCLUSIVE");
  try {assert.throws(()=>state.status(),{code:"SERVICE_UNAVAILABLE"});}
  finally {f.db.exec("ROLLBACK");}
  f.db.pragma("journal_mode = WAL");
  insertOverride(f,101,"dismissed");assert.equal(state.overrides().get("42:101").status,"dismissed");
  const empty=path.join(f.dir,"empty.db");new Database(empty).close();
  assert.deepEqual(createReadState(empty).status(),{monitoring:"running",calendarSyncEnabled:true});
  assert.equal(createReadState(empty).overrides().size,0);
  const inspect=new Database(empty,{readonly:true,fileMustExist:true});
  assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master").get().n,0);inspect.close();
  const malformed=path.join(f.dir,"malformed.db");const bad=new Database(malformed);
  bad.exec("CREATE TABLE app_settings (bad TEXT)");bad.close();
  assert.throws(()=>createReadState(malformed).status(),{code:"SERVICE_UNAVAILABLE"});
  const missing=path.join(f.dir,"missing.db");
  assert.throws(()=>createReadState(missing).status(),{code:"SERVICE_UNAVAILABLE"});assert.equal(fs.existsSync(missing),false);
});
test("registry denies permissions, duplicates, binding change, scope and exact expiry",t=>{
  const f=fixture(t);
  const auth=createCoreAuth(f.file,bindingOf(readRegistry(f.file)),()=>now);
  assert.deepEqual(auth("Bearer "+token),{deviceId,accountId});
  fs.chmodSync(f.file,0o644);assert.throws(()=>auth("Bearer "+token),{code:"SERVICE_UNAVAILABLE"});
  f.write();f.registry.devices.push({...f.registry.devices[0]});f.write();
  assert.throws(()=>auth("Bearer "+token),{code:"SERVICE_UNAVAILABLE"});
  f.registry.devices.pop();f.registry.canvasProfileId="100";f.write();
  assert.throws(()=>auth("Bearer "+token),{code:"ACCOUNT_UNVERIFIED"});
});

test("main fixture and startup account binding, complete zero, isolated service coalescing",async t=>{
  const f=fixture(t,false), before=f.snapshot();
  const env={GUARDIAN_CORE_REGISTRY:f.file,CANVAS_BASE_URL:origin,CANVAS_ACCESS_TOKEN:"synthetic"};
  await assert.rejects(startCoreApi({env,fetchImpl:async()=>json({id:100}),port:0}),{code:"ACCOUNT_UNVERIFIED"});
  await assert.rejects(startCoreApi({env:{...env,CANVAS_BASE_URL:"https://other.example"},fetchImpl:async()=>{throw Error("must not fetch");},port:0}),{code:"ACCOUNT_UNVERIFIED"});
  const app=await startCoreApi({env,fetchImpl:async url=>new URL(url).pathname.endsWith("/profile")?json({id:99}):json([]),now:()=>now,port:0});
  t.after(()=>app.stop());
  const empty=await request(app.server,"/v1/activities");
  assert.equal(empty.status,200);assert.equal(empty.body.page.total,0);assert.deepEqual(empty.body.items,[]);
  assert.deepEqual(f.snapshot(),before);
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const service=createActivityService({canvas:{async load(){calls++;await gate;return [];}},
    state:{overrides:()=>new Map()},accountId,now:()=>now,monotonic:()=>0});
  const query={view:"pending",limit:50,offset:0};
  const a=service.activities(query),b=service.activities(query);
  await Promise.resolve();assert.equal(calls,1);release();
  const results=await Promise.all([a,b]);
  assert.deepEqual(results.map(x=>x.freshness.state),["fresh","fresh"]);
  assert.equal((await service.activities(query)).freshness.state,"cached");
  await service.stop();
});
