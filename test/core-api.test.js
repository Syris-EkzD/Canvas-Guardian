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
const { migrateCore } = require("../src/core-schema");
const { createAcademicState } = require("../src/core-academic-state");

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
  const snapshot = () => legacySnapshot(db);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,statePath,registry,db,write,snapshot};
}
function legacySnapshot(db) {
  const schema = db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE tbl_name NOT GLOB 'guardian_*' ORDER BY name").all();
  const rows = schema.filter(x => x.type === "table").map(({name}) => ({
    name, rows: db.prepare('SELECT * FROM "' + name.replace(/"/g,'""') + '" ORDER BY 1').all()
  }));
  return {schema, rows};
}
function envFor(f) {
  return {GUARDIAN_CORE_REGISTRY:f.file,CANVAS_BASE_URL:origin,CANVAS_ACCESS_TOKEN:"synthetic"};
}
async function migrate(f, options = {}) {
  return migrateCore({registryFile:f.file,env:envFor(f),expectedPath:f.statePath,
    backupPath:path.join(f.dir,"backup.db"),now:()=>now,fetchImpl:async(url,opts)=>{
      assert.equal(url,origin+"/api/v1/users/self/profile");
      assert.equal(opts.method,"GET");assert.equal(opts.redirect,"manual");
      return json({id:99});
    },...options});
}
function academic(f, options = {}) {
  return createAcademicState({binding:bindingOf(f.registry),registryFile:f.file,expectedPath:f.statePath,...options});
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
  await migrate(f);
  const app = await startCoreApi({env:envFor(f),expectedPath:f.statePath,
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
  await migrate(f);
  const env=envFor(f), expectedPath=f.statePath;
  await assert.rejects(startCoreApi({env,expectedPath,fetchImpl:async()=>json({id:100}),port:0}),{code:"ACCOUNT_UNVERIFIED"});
  await assert.rejects(startCoreApi({env:{...env,CANVAS_BASE_URL:"https://other.example"},expectedPath,fetchImpl:async()=>{throw Error("must not fetch");},port:0}),{code:"ACCOUNT_UNVERIFIED"});
  const app=await startCoreApi({env,expectedPath,fetchImpl:async url=>new URL(url).pathname.endsWith("/profile")?json({id:99}):json([]),now:()=>now,port:0});
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

test("request-target, header, body and malformed state rejection are bounded",async t=>{
  const f=fixture(t),u=upstream(),server=await runtime(t,f,u,{tick:0});
  assert.equal((await request(server,"/v1/activities?view="+"x".repeat(2048))).status,400);
  const raw=options=>new Promise((resolve,reject)=>{
    const req=http.request({host:"127.0.0.1",port:server.address().port,path:"/v1/status",...options},
      res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});
    req.on("error",reject);req.end();
  });
  assert.equal(await raw({headers:{Authorization:"Bearer "+token,"X-Test":["one","two"]}}),400);
  assert.equal(await raw({headers:{Authorization:"Bearer "+token,"X-Test":"x".repeat(8192)}}),431);
  assert.equal(await raw({method:"GET",headers:{Authorization:"Bearer "+token,"Transfer-Encoding":"chunked"}}),400);
  assert.equal(u.calls,1);
  f.db.prepare("UPDATE app_settings SET value='bogus' WHERE key='monitoring_state'").run();
  assert.equal((await request(server,"/v1/status")).body.error.code,"SERVICE_UNAVAILABLE");
  f.db.prepare("INSERT INTO activity_status_overrides VALUES (?,?,?)").run("invalid","dismissed","not-a-date");
  assert.equal((await request(server,"/v1/activities")).body.error.code,"SERVICE_UNAVAILABLE");
});
test("missing registry and absent read scope never dispatch; explicit stop aborts refresh",async t=>{
  const f=fixture(t);
  let entered, signalSeen;
  const started=new Promise(resolve=>{entered=resolve;});
  const env={GUARDIAN_CORE_REGISTRY:f.file,CANVAS_BASE_URL:origin,CANVAS_ACCESS_TOKEN:"synthetic"};
  await migrate(f);
  const app=await startCoreApi({env,expectedPath:f.statePath,now:()=>now,port:0,fetchImpl:async(url,{signal})=>{
    if(new URL(url).pathname.endsWith("/profile"))return json({id:99});
    signalSeen=signal;entered();
    return new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  }});
  let stopped=false;
  t.after(async()=>{if(!stopped)await app.stop();});
  fs.unlinkSync(f.file);
  assert.equal((await request(app.server,"/v1/activities")).status,503);
  assert.equal(signalSeen,undefined);
  f.write();
  const pending=request(app.server,"/v1/activities").catch(error=>error);
  await started;
  await app.stop();stopped=true;
  await pending;
  assert.equal(signalSeen.aborted,true);
  assert.equal(app.server.listening,false);
  assert.equal(academic(f).read().sync.generation,0);
});

test("explicit migration preserves main, candidate, older ALTER variant, empty and WAL with verified backup",async t=>{
  for (const variant of ["main","candidate","older","empty","wal"]) {
    await t.test(variant,async t=>{
      const f=fixture(t,variant!=="main"&&variant!=="empty");
      if (variant==="older") f.db.exec("ALTER TABLE ai_submissions DROP COLUMN destination_json");
      if (variant==="empty") {
        for (const {name} of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
          f.db.exec("DROP TABLE "+name);
      } else {
        f.db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO unrelated VALUES (1,'kept');"+
          "CREATE INDEX unrelated_value ON unrelated(value)");
        f.db.prepare("INSERT INTO app_settings VALUES ('activity_baseline_created',?),('announcement_baseline_created',?)")
          .run(new Date(now).toISOString(),new Date(now-1000).toISOString());
        insertOverride(f,101,"dismissed");
      }
      if (variant==="wal") {
        f.db.pragma("journal_mode=WAL");
        f.db.prepare("INSERT INTO app_settings VALUES ('wal_fixture','committed')").run();
      }
      if (variant==="candidate"||variant==="wal") {
        f.db.exec("INSERT INTO ai_submissions VALUES ('checking','42','42','101','Worksheet','text','synthetic','advice','checking',1,2,'{}'),"+
          "('submitting','42','42','101','Worksheet','text','synthetic','advice','submitting',1,2,'{}');"+
          "INSERT INTO ai_setting_confirmations VALUES ('applying','42','monitoring','paused','applying',1,2);");
      }
      f.db.pragma("user_version=37");
      const before=f.snapshot();
      assert.deepEqual(await migrate(f),{version:1,migrated:true});
      assert.equal(f.db.pragma("user_version",{simple:true}),37);
      assert.deepEqual(f.snapshot(),before);
      assert.deepEqual(await migrate(f),{version:1,migrated:false});
      assert.deepEqual(f.snapshot(),before);
      const restored=path.join(f.dir,"restored.db");
      fs.copyFileSync(path.join(f.dir,"backup.db"),restored);
      const copy=new Database(restored,{readonly:true,fileMustExist:true});
      try {
        assert.deepEqual(legacySnapshot(copy),before);
        assert.equal(copy.pragma("integrity_check",{simple:true}),"ok");
        assert.equal(copy.pragma("user_version",{simple:true}),37);
        assert.deepEqual(copy.pragma("foreign_key_check"),[]);
        assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'guardian_%'").get().n,0);
      } finally {copy.close();}
      assert.equal(academic(f).read().sync.generation,0);
      if (variant==="wal") assert.equal(f.db.pragma("journal_mode",{simple:true}),"wal");
    });
  }
});

test("migration refuses unsafe paths, unknown schema, locks, mismatched identity and rolls back atomically",async t=>{
  const f=fixture(t),before=f.snapshot();
  const hasSchema=()=>f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'guardian_%'").get().n;
  let providerCalls=0;
  await assert.rejects(startCoreApi({env:envFor(f),expectedPath:f.statePath,port:0,fetchImpl:async()=>{providerCalls++;return json({id:99});}}),{code:"SERVICE_UNAVAILABLE"});
  assert.equal(providerCalls,0);assert.equal(hasSchema(),0);
  await assert.rejects(migrate(f,{expectedPath:path.join(f.dir,"other.db")}),{code:"ACCOUNT_UNVERIFIED"});
  await assert.rejects(migrate(f,{fetchImpl:async()=>json({id:100})}),{code:"ACCOUNT_UNVERIFIED"});
  f.db.exec("BEGIN EXCLUSIVE");
  try {await assert.rejects(migrate(f),{code:"SERVICE_UNAVAILABLE"});} finally {f.db.exec("ROLLBACK");}
  const unsafe=path.join(f.dir,"sidecar.db");
  fs.writeFileSync(unsafe+"-wal","sentinel",{mode:0o600});
  await assert.rejects(migrate(f,{backupPath:unsafe}),{code:"SERVICE_UNAVAILABLE"});
  assert.equal(fs.existsSync(unsafe),false);
  assert.equal(fs.readFileSync(unsafe+"-wal","utf8"),"sentinel");
  await assert.rejects(migrate(f,{beforeCommit:()=>{throw Error("injected");}}),{code:"SERVICE_UNAVAILABLE"});
  assert.equal(hasSchema(),0);assert.deepEqual(f.snapshot(),before);
  const savedBackup=fs.readFileSync(path.join(f.dir,"backup.db"));
  await assert.rejects(migrate(f),{code:"SERVICE_UNAVAILABLE"});
  assert.deepEqual(fs.readFileSync(path.join(f.dir,"backup.db")),savedBackup);
  assert.deepEqual(await migrate(f,{backupPath:path.join(f.dir,"retry.db")}),{version:1,migrated:true});
  f.registry.ownerId="00000000-0000-4000-8000-000000000008";f.write();
  await assert.rejects(migrate(f),{code:"ACCOUNT_UNVERIFIED"});
  await assert.rejects(startCoreApi({env:envFor(f),expectedPath:f.statePath,port:0,fetchImpl:async()=>{throw Error("must not fetch");}}),{code:"ACCOUNT_UNVERIFIED"});
  assert.deepEqual(f.snapshot(),before);
});

test("malformed, newer and missing DBs are denied without creation or legacy rewrite",async t=>{
  const f=fixture(t);
  f.db.exec("CREATE TABLE guardian_schema_migrations (version INTEGER PRIMARY KEY,applied_at TEXT); INSERT INTO guardian_schema_migrations VALUES (2,'2026-11-27');");
  await assert.rejects(migrate(f),{code:"SERVICE_UNAVAILABLE"});
  f.db.exec("DROP TABLE guardian_schema_migrations; DROP TABLE app_settings; CREATE TABLE app_settings (bad TEXT)");
  await assert.rejects(migrate(f),{code:"SERVICE_UNAVAILABLE"});
  assert.equal(f.db.prepare("PRAGMA table_info(app_settings)").get().name,"bad");
  const missing=path.join(f.dir,"missing.db");
  f.registry.statePath=missing;f.write();
  await assert.rejects(migrate(f,{expectedPath:missing}),{code:"SERVICE_UNAVAILABLE"});
  assert.equal(fs.existsSync(missing),false);
  const symlink=path.join(f.dir,"linked.db");fs.symlinkSync(f.statePath,symlink);
  f.registry.statePath=symlink;f.write();
  await assert.rejects(migrate(f,{expectedPath:symlink}),{code:"SERVICE_UNAVAILABLE"});
});

function courseUpstream() {
  const state={roster:[{id:"42",name:"NET101"},{id:"7",name:"Zero work"}],
    rows:{"42":[{id:"101",name:"Saved",published:true,due_at:"2026-11-28T11:00:00Z"},
      {id:"102",name:"Submitted",published:true,submission:{workflow_state:"submitted"}},
      {id:"103",name:"Private draft",published:false},
      {id:"104",name:"Excused",published:true,submission:{excused:true}}],"7":[]},
    fail:0,malformed:false,foreign:false,partial:false,profile:"99",calls:[]};
  state.fetchImpl=async(url,options)=>{
    assert.equal(options.method,"GET");assert.equal(options.redirect,"manual");
    const u=new URL(url);assert.equal(u.origin,origin);state.calls.push(u.pathname);
    if(u.pathname.endsWith("/profile"))return json({id:state.profile});
    if(u.pathname==="/api/v1/courses")return json(state.roster);
    if(state.fail) {
      const response=new Response("private upstream evidence",{status:state.fail});
      if(state.foreign)Object.defineProperty(response,"url",{value:"https://foreign.example/private"});
      return response;
    }
    if(state.partial) {
      if(u.searchParams.has("page"))return new Response("failed second page",{status:500});
      return new Response(JSON.stringify(state.rows[u.pathname.split("/")[4]]||[]),
        {headers:{link:"<"+origin+u.pathname+"?page=2>; rel=next"}});
    }
    if(state.malformed)return new Response("[]",{headers:{link:'<https://canvas.example.edu'+u.pathname+'?page=2>; title="; rel=next"'}});
    return json(state.rows[u.pathname.split("/")[4]]||[]);
  };
  return state;
}
async function startCourses(t,f,u,clock) {
  const app=await startCoreApi({env:envFor(f),expectedPath:f.statePath,fetchImpl:u.fetchImpl,
    now:()=>clock.wall,monotonic:()=>clock.tick,port:0});
  t.after(()=>app.stop());
  return app;
}

test("course reads include zero work, exact DTOs, saved/submitted, lexical paging and strict access boundaries",async t=>{
  const f=fixture(t),u=courseUpstream(),clock={wall:now,tick:0};
  insertOverride(f,101,"dismissed");
  await migrate(f);
  const app=await startCourses(t,f,u,clock),server=app.server;
  const first=await request(server,"/v1/courses?limit=1");
  assert.equal(first.status,200);assert.deepEqual(Object.keys(first.body).sort(),["accountId","evaluatedAt","items","page","sync","timezone"]);
  assert.equal(first.body.accountId,accountId);
  assert.deepEqual(first.body.items[0],{courseId:"42",courseName:"NET101",archiveState:"active",archivedAt:null,stateVersion:0,
    upstreamPresence:"present",lastSeenAt:new Date(now).toISOString(),assignmentFetchedAt:new Date(now).toISOString()});
  assert.deepEqual(first.body.sync,{lastSuccessAt:new Date(now).toISOString(),lastAttemptAt:new Date(now).toISOString(),state:"fresh",lastResult:"success",errorCode:null});
  const next=await request(server,"/v1/courses?limit=1&offset=1&revision="+first.body.page.revision);
  assert.equal(next.body.items[0].courseId,"7");assert.equal(next.body.sync.state,"cached");
  assert.equal(u.calls.length,5); // startup profile + refresh profile + roster + 2 courses
  clock.wall=now-1000;
  assert.equal((await request(server,"/v1/courses")).body.sync.state,"stale");
  clock.wall=now;
  const detail=await request(server,"/v1/courses/7");
  assert.equal(detail.body.course.courseName,"Zero work");
  const empty=await request(server,"/v1/courses/7/assignments");
  assert.equal(empty.body.page.total,0);assert.deepEqual(empty.body.items,[]);
  const list=await request(server,"/v1/courses/42/assignments");
  assert.equal(list.status,200);assert.deepEqual(list.body.freshness,{fetchedAt:new Date(now).toISOString(),state:"cached"});
  assert.deepEqual(list.body.items.map(x=>[x.assignmentId,x.guardianStatus]),[["101","dismissed"],["102","submitted"],["104",null]]);
  assert.deepEqual(list.body.items[0],{key:"42:101",courseId:"42",assignmentId:"101",title:"Saved",
    dueAt:"2026-11-28T11:00:00.000Z",canvasUrl:null,published:true,submitted:false,excused:null,
    guardianStatus:"dismissed",presence:"present",lastSeenAt:new Date(now).toISOString()});
  f.db.prepare("DELETE FROM activity_status_overrides WHERE assignment_key='42:101'").run();
  assert.equal((await request(server,"/v1/courses/42/assignments?revision="+list.body.page.revision)).status,409);
  assert.equal((await request(server,"/v1/courses/99")).status,404);
  for (const target of ["/v1/courses?view=saved","/v1/courses?ownerId=x","/v1/courses?offset=1",
    "/v1/courses/042","/v1/courses/%34%32","/v1/courses/42?x=y","/v1/courses/42/assignments?view=historical"])
    assert.equal((await request(server,target)).status,400,target);
  assert.equal((await request(server,"/v1/courses/42/archive",token,{method:"PUT"})).status,404);
  assert.equal((await request(server,"/v1/courses/42",token,{method:"DELETE"})).status,405);
  f.registry.devices[0].scopes=[];f.write();
  assert.equal((await request(server,"/v1/courses")).status,403);
  f.registry.devices[0].scopes=["academic:read"];f.registry.devices[0].revokedAt=new Date(now).toISOString();f.write();
  assert.equal((await request(server,"/v1/courses/42/assignments")).status,401);
  assert.equal(u.calls.length,5);
});

test("atomic history, partial failures, stale/never distinction, restart, clock skew and identity latch",async t=>{
  const f=fixture(t),u=courseUpstream(),clock={wall:now,tick:0};
  await migrate(f);
  const app=await startCourses(t,f,u,clock),server=app.server;
  u.fail=500;
  assert.equal((await request(server,"/v1/courses")).status,502);
  assert.equal(academic(f).read().sync.generation,0);
  u.fail=0;
  assert.equal((await request(server,"/v1/courses")).status,200);
  const generation=academic(f).capture();
  u.roster=[{id:"42",name:"Renamed"}];u.rows["42"]=[{id:"102",name:"Submitted",published:true,submission:{workflow_state:"submitted"}}];
  clock.tick+=60000;clock.wall+=60000;u.fail=500;
  const stale=await request(server,"/v1/courses");
  assert.equal(stale.body.sync.state,"stale");assert.equal(stale.body.sync.lastResult,"failed");
  assert.equal(stale.body.items.length,2);assert.equal(academic(f).capture(),generation);
  assert.equal((await request(server,"/v1/courses/999")).status,502);
  assert.equal((await request(server,"/v1/activities")).status,502);
  u.fail=401;assert.equal((await request(server,"/v1/courses")).status,502);
  u.fail=500;u.foreign=true;
  assert.equal((await request(server,"/v1/courses")).body.error.code,"UPSTREAM_INVALID");
  u.fail=0;u.foreign=false;u.partial=true;
  const partial=await request(server,"/v1/courses");
  assert.equal(partial.body.sync.state,"stale");assert.equal(partial.body.items.length,2);
  assert.equal(academic(f).capture(),generation);
  u.partial=false;u.malformed=true;
  assert.equal((await request(server,"/v1/courses")).body.error.code,"UPSTREAM_INVALID");
  assert.equal(academic(f).capture(),generation);
  u.malformed=false;
  const refreshed=await request(server,"/v1/courses");
  assert.equal(refreshed.body.items[0].courseName,"Renamed");
  assert.equal(refreshed.body.items.length,1);
  const hist=await request(server,"/v1/courses?view=historical");
  assert.equal(hist.body.items[0].courseId,"7");assert.equal(hist.body.items[0].archiveState,"active");
  assert.equal(hist.body.items[0].upstreamPresence,"not_in_active_roster");
  assert.equal((await request(server,"/v1/courses/42/assignments")).body.page.total,1);
  clock.tick+=60000;clock.wall+=60000;u.roster=[];
  assert.equal((await request(server,"/v1/courses")).body.page.total,0);
  const old=await request(server,"/v1/courses/42/assignments");
  assert.equal(old.body.freshness.state,"stale");
  assert.deepEqual(old.body.items.map(x=>[x.assignmentId,x.presence]),[
    ["101","not_in_latest_complete_course"],["102","present"],["104","not_in_latest_complete_course"]]);
  assert.equal(old.body.items.some(x=>x.assignmentId==="103"),false);
  clock.tick+=60000;clock.wall+=60000;u.roster=[{id:"42",name:"Back"}];u.rows["42"]=[{id:"101",name:"Returned",published:true}];
  assert.equal((await request(server,"/v1/courses/42/assignments")).body.items[0].title,"Returned");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM guardian_assignments").get().n,4);
  await app.stop();
  u.fail=500;clock.tick=0;clock.wall=now-1000;
  const restarted=await startCourses(t,f,u,clock);
  const after=await request(restarted.server,"/v1/courses");
  assert.equal(after.body.sync.state,"stale");
  assert.equal((await request(restarted.server,"/v1/activities")).status,502);
  u.fail=0;u.profile="100";
  assert.equal((await request(restarted.server,"/v1/courses")).body.error.code,"ACCOUNT_UNVERIFIED");
  u.profile="99";
  assert.equal((await request(restarted.server,"/v1/status")).body.error.code,"ACCOUNT_UNVERIFIED");
});

test("generation CAS and retention caps are atomic; unexpected archive state fails closed",async t=>{
  const f=fixture(t);await migrate(f);
  const first=academic(f,{maxCourses:2,maxAssignments:2}), second=academic(f);
  const at=new Date(now).toISOString();
  const candidate=(course,ids)=>({courses:[{id:course,course_code:"Course"}],items:ids.map(id=>({
    courseId:course,id,name:"Synthetic",published:true,submitted:false,dueAt:null,htmlUrl:null
  }))});
  const a=first.capture(),b=second.capture();
  assert.equal(first.publish(a,candidate("42",["1"]),at,at),1);
  assert.throws(()=>second.publish(b,candidate("43",["2"]),at,at),{code:"SNAPSHOT_UNAVAILABLE"});
  second.recordFailure(b,at,"UPSTREAM_FAILED");
  assert.equal(first.read().sync.last_result,"success");
  assert.throws(()=>first.publish(1,candidate("43",["2","3"]),at,at),{code:"SNAPSHOT_UNAVAILABLE"});
  assert.equal(first.capture(),1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM guardian_assignments").get().n,1);
  assert.equal(first.publish(1,candidate("43",["2"]),at,at),2);
  assert.throws(()=>first.publish(2,candidate("44",[]),at,at),{code:"SNAPSHOT_UNAVAILABLE"});
  assert.equal(first.capture(),2);assert.equal(first.read().courses.length,2);
  f.db.prepare("UPDATE guardian_courses SET local_state='archived' WHERE course_id='42'").run();
  assert.throws(()=>first.capture(),{code:"SERVICE_UNAVAILABLE"});
});

test("retained assignment history is pageable across legacy offset boundary without widening old routes",async t=>{
  const f=fixture(t),u=courseUpstream(),clock={wall:now,tick:0};
  await migrate(f);
  const store=academic(f),at=new Date(now).toISOString();
  const courses=[{id:"42",course_code:"History"}];
  const item=id=>({courseId:"42",id:String(id),name:"Work",published:true,submitted:false});
  store.publish(0,{courses,items:Array.from({length:10000},(_,i)=>item(i+1))},at,at);
  store.publish(1,{courses,items:[item(10001)]},at,at);
  u.roster=[];
  const app=await startCourses(t,f,u,clock),server=app.server;
  const first=await request(server,"/v1/courses/42/assignments?limit=1");
  assert.equal(first.status,200);assert.equal(first.body.page.total,10001);
  const last=await request(server,"/v1/courses/42/assignments?offset=10000&revision="+first.body.page.revision);
  assert.equal(last.status,200);assert.equal(last.body.items.length,1);assert.equal(last.body.page.nextOffset,null);
  for(const target of ["/v1/activities?offset=10001","/v1/courses?offset=10001","/v1/courses/42/assignments?offset=100001"])
    assert.equal((await request(server,target+"&revision="+first.body.page.revision)).status,400);
});

test("revoked device cannot receive in-flight new course read",async t=>{
  const f=fixture(t),u=upstream();
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  u.setWait(async()=>{entered();await gate;});
  const server=await runtime(t,f,u,{tick:0});
  const pending=request(server,"/v1/courses");
  await started;
  f.registry.devices[0].revokedAt=new Date(now).toISOString();f.write();release();
  const result=await pending;
  assert.equal(result.status,401);assert.equal(result.body.items,undefined);
});
