const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCoreCanvas } = require("../src/core-canvas");
const origin = "https://canvas.example.edu";
const profile = "/api/v1/users/self/profile";
const courses = "/api/v1/courses";
const assignments = id => courses + "/" + id + "/assignments";
const row = (id, extra = {}) => ({id, name:"Worksheet", published:true, due_at:"2026-11-27T12:00:00Z", ...extra});
const json = (value, link) => new Response(JSON.stringify(value), {headers: link ? {link} : {}});
const link = path => "<" + origin + path + ">; rel=\"next\"";
const create = (fetchImpl, options = {}) => createCoreCanvas({baseUrl:origin, token:"synthetic", profileId:"99", fetchImpl,...options});

test("complete pagination, exact GET/origin, URL projection and legacy graded normalization", async () => {
  const calls = [];
  const canvas = create(async (url, options) => {
    const u = new URL(url);
    calls.push(u.pathname + (u.searchParams.has("page") ? "?page=2" : ""));
    assert.equal(u.origin, origin);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer synthetic");
    if (u.pathname === profile) return json({id:99});
    if (u.pathname === courses) return u.searchParams.has("page") ? json([{id:"43",name:"Other"}])
      : json([{id:42,name:"First"}], link(courses+"?page=2") + ", <"+origin+courses+"?page=2>; rel=\"last\"");
    if (u.pathname === assignments(42)) return u.searchParams.has("page") ? json([row(102,{submission:{workflow_state:"graded",missing:false}})])
      : json([row(101,{html_url:origin+"/courses/42/assignments/101?secret=redacted#x",submission:{workflow_state:"graded",missing:true}})],link(assignments(42)+"?page=2"));
    return json([row("103",{html_url:"https://foreign.example/evil"})]);
  });
  const result = await canvas.load();
  assert.deepEqual(calls,[profile,courses,courses+"?page=2",assignments(42),assignments(42)+"?page=2",assignments(43)]);
  assert.deepEqual(result.map(x=>x.key),["42:101","42:102","43:103"]);
  assert.deepEqual(result.map(x=>x.submitted),[false,true,false]);
  assert.equal(result[0].htmlUrl,origin+"/courses/42/assignments/101");
  assert.equal(result[2].htmlUrl,null);
});
test("complete zero is distinct from failure", async () => {
  assert.deepEqual(await create(async url => new URL(url).pathname===profile?json({id:99}):json([])).load(),[]);
});
test("reject incomplete, foreign, cyclic, malformed, redirect and budget failures", async () => {
  const cases = [
    ["foreign", () => json([], "<https://evil.example/api/v1/courses?page=2>; rel=\"next\"")],
    ["different path", () => json([], link("/api/v1/users"))],
    ["cycle", url => json([], "<"+url+">; rel=\"next\"")],
    ["malformed link", () => json([], "broken; rel=\"next\"")],
    ["non-array", () => json({data:[]})],
    ["unsafe course", () => json([{id:9007199254740992,name:"X"}])],
    ["duplicate", () => json([{id:42,name:"X"},{id:"42",name:"X"}])],
    ["redirect", () => new Response(null,{status:302,headers:{location:"https://evil.example/"}})],
  ];
  for (const [label, response] of cases) {
    await assert.rejects(create(async url => new URL(url).pathname===profile?json({id:99}):response(url)).load(), {code:"UPSTREAM_INVALID"},label);
  }
  const first = async url => {
    const u = new URL(url);
    if (u.pathname===profile) return json({id:99});
    if (u.pathname===courses) return json([{id:42,name:"X"}]);
    return json([row(101)],link(assignments(42)+"?page=2"));
  };
  await assert.rejects(create(first,{maxPages:3}).load(),{code:"UPSTREAM_INVALID"});
  for (const bad of [row("01"),row(1,{due_at:"2026-02-30T00:00:00Z"}),row(1,{published:"true"}),row(1,{submission:[]}),row(1,{course_id:43})]) {
    await assert.rejects(create(async url => {
      const p = new URL(url).pathname;
      return p===profile?json({id:99}):p===courses?json([{id:42,name:"X"}]):json([bad]);
    }).load(),{code:"UPSTREAM_INVALID"});
  }
  await assert.rejects(create(async url => {
    const u = new URL(url);
    if (u.pathname===profile) return json({id:99});
    if (u.pathname===courses) return json([{id:42,name:"X"}]);
    if (u.searchParams.has("page")) return new Response("private upstream details",{status:401});
    return json([row(101)],link(assignments(42)+"?page=2"));
  }).load(),{code:"UPSTREAM_FAILED"});
  await assert.rejects(create(async()=>json({id:100})).load(),{code:"ACCOUNT_UNVERIFIED"});
  await assert.rejects(create(async()=>new Response(null,{status:429,headers:{"retry-after":"12"}})).load(),{code:"SERVICE_UNAVAILABLE",retryAfter:12});
});
test("timeout cancels real abort-aware synthetic request", async () => {
  const keepAlive = setInterval(()=>{},1000);
  try {
    await assert.rejects(create((_url,{signal})=>new Promise((resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    }),{deadlineMs:20,requestMs:100}).load(),{code:"UPSTREAM_TIMEOUT"});
  } finally {clearInterval(keepAlive);}
});

test("row and byte budgets fail entire refresh; mismatched submission identity rejected", async () => {
  const mock = rows => async url => {
    const p = new URL(url).pathname;
    return p===profile?json({id:99}):p===courses?json([{id:42,name:"X"}]):json(rows);
  };
  await assert.rejects(create(mock([row(1),row(2)]),{maxRows:1}).load(),{code:"UPSTREAM_INVALID"});
  await assert.rejects(create(mock([row(1,{name:"x".repeat(2*1024*1024)})])).load(),{code:"UPSTREAM_INVALID"});
  for (const submission of [{user_id:98},{assignment_id:2},{missing:"false"},{excused:"true"}])
    await assert.rejects(create(mock([row(1,{submission})])).load(),{code:"UPSTREAM_INVALID"});
});

test("pagination follows real relations despite quoted rel-like text and opaque cursors", async () => {
  const courseNext = origin + courses + "?cursor=a,b;rel=last";
  const assignmentNext = origin + assignments(42) + "?cursor=x%2By%3D";
  const calls = [];
  const canvas = create(async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    const p = new URL(url).pathname;
    if (p === profile) return json({id:99});
    if (url === courseNext) return json([{id:43,name:"Later course"}]);
    if (p === courses) return json([{id:42,name:"First course"}],
      "<" + courseNext + '>; title="x; rel=last; y=z, \\"quoted\\""; REL="next last", ' +
      "<" + origin + courses + '?page=1>; rel=first; title="; rel=next"');
    if (url === assignmentNext) return json([row(102)]);
    if (p === assignments(42)) return json([row(101)],
      "<?cursor=x%2By%3D>; title=\"backslash \\\\ and comma, semicolon;\"; rel=next");
    if (p === assignments(43)) return json([row(103)]);
    assert.fail("unexpected request: " + url);
  });
  assert.deepEqual((await canvas.load()).map(x=>x.key), ["42:101","42:102","43:103"]);
  assert.ok(calls.includes(courseNext));
  assert.ok(calls.includes(assignmentNext));
});

test("malformed or ambiguous Link relations fail the whole snapshot before following any next URL", async () => {
  const target = "<" + origin + courses + "?page=2>";
  const another = "<" + origin + courses + "?page=3>";
  const valid = target + '; rel="next"';
  const malformed = [
    ["missing real rel", target + '; title="x; rel=last; y=z"'],
    ["fake rel in target", "<" + origin + courses + "?cursor=x;rel=last>; title=x"],
    ["empty relation", target + '; rel=""'],
    ["missing relation value", target + "; rel="],
    ["invalid relation token", target + '; rel="next,last"'],
    ["invalid relation syntax", target + '; rel="next=last"'],
    ["duplicate rel parameters", valid + '; REL="last"'],
    ["duplicate relation type", target + '; rel="next NEXT"'],
    ["multiple actual next", valid + ", " + another + "; rel=next"],
    ["repeated same next", valid + ", " + valid],
    ["leading comma", ", " + valid],
    ["trailing comma", valid + ","],
    ["empty middle element", valid + ",, " + another + "; rel=last"],
    ["missing comma", valid + " " + another + "; rel=last"],
    ["missing semicolon", target + ' rel="next"'],
    ["empty parameter", valid + ";; title=x"],
    ["unterminated quote", target + '; rel=next; title="unterminated'],
    ["garbage after quoted relation", target + '; rel="next"oops'],
    ["valid next followed by malformed link", valid + ", " + another + '; title="; rel=last"'],
  ];
  for (const [label, header] of malformed) {
    const calls = [];
    await assert.rejects(create(async url => {
      calls.push(url);
      return new URL(url).pathname === profile ? json({id:99}) : json([{id:42,name:"First"}],header);
    }).load(), {code:"UPSTREAM_INVALID"}, label);
    assert.equal(calls.length, 2, label);
  }
});

test("malformed assignment page relation cannot publish previously collected rows", async () => {
  const calls = [];
  await assert.rejects(create(async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === profile) return json({id:99});
    if (u.pathname === courses) return json([{id:42,name:"First"}]);
    if (!u.searchParams.has("page")) return json([row(101)], link(assignments(42)+"?page=2"));
    return json([row(102)], "<" + origin + assignments(42) + '?page=3>; title="; rel=last"');
  }).load(), {code:"UPSTREAM_INVALID"});
  assert.equal(calls.length, 4);
});
