const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture(send) {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  const calls = [];
  const runtime = {
    sendMessage(message, callback) {
      calls.push(message);
      send(runtime, callback, calls.length);
    }
  };
  const context = vm.createContext({
    setTimeout(fn, ms) {
      const id = ++serial;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared.js"), "utf8"), context);
  return {
    core: context.YTBTCore, runtime, calls, timers,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    }
  };
}

function fail(runtime, callback, message = "Could not establish connection. Receiving end does not exist.") {
  runtime.lastError = { message };
  try { callback(); } finally { delete runtime.lastError; }
}

test("a waking background receives the same batch after bounded reconnect delays", async () => {
  const f = fixture((runtime, callback, count) => count < 3 ? fail(runtime, callback) : callback({ ok: true }));
  const message = { type: "TRANSLATE_BATCH", batchId: "seek-1", cues: [{ id: "1" }] };
  const result = f.core.sendRuntimeMessage(f.runtime, message, 10000);
  f.tick(249);
  assert.equal(f.calls.length, 1);
  f.tick(1);
  assert.equal(f.calls.length, 2);
  f.tick(750);
  assert.equal((await result).ok, true);
  assert.ok(f.calls.every((value) => value === message));
  assert.equal(f.timers.size, 0);
});

test("persistent missing listener stops after three retries and gives recovery instructions", async () => {
  const f = fixture((runtime, callback) => fail(runtime, callback));
  const result = f.core.sendRuntimeMessage(f.runtime, {}, 10000);
  const rejected = assert.rejects(result, /扩展后台暂时无法连接.*拖动进度条.*刷新/);
  f.tick(10000);
  await rejected;
  assert.equal(f.calls.length, 4);
  assert.equal(f.timers.size, 0);
});

test("a new seek request reconnects after an earlier request succeeded", async () => {
  let unavailable = false;
  const delivered = [];
  const f = fixture((runtime, callback) => {
    if (unavailable) fail(runtime, callback);
    else {
      delivered.push(f.calls.at(-1).batchId);
      callback({ ok: true });
    }
  });
  await f.core.sendRuntimeMessage(f.runtime, { batchId: "before-idle" }, 10000);
  unavailable = true;
  const afterSeek = f.core.sendRuntimeMessage(f.runtime, { batchId: "after-seek" }, 10000);
  f.tick(250);
  unavailable = false;
  f.tick(750);
  assert.equal((await afterSeek).ok, true);
  assert.deepEqual(delivered, ["before-idle", "after-seek"]);
  assert.equal(f.timers.size, 0);
});

test("port closure does not replay a possibly delivered paid request", async () => {
  const f = fixture((runtime, callback) => fail(runtime, callback, "The message port closed before a response was received."));
  await assert.rejects(f.core.sendRuntimeMessage(f.runtime, {}, 10000), /port closed/);
  f.tick(10000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test("a synchronous invalidated-context error has a refresh hint and no leaked timers", async () => {
  const f = fixture(() => { throw new Error("Extension context invalidated."); });
  await assert.rejects(f.core.sendRuntimeMessage(f.runtime, {}, 10000), /扩展已更新.*刷新/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test("deadline includes reconnect delays and cancels unsent retries", async () => {
  const f = fixture((runtime, callback) => fail(runtime, callback));
  const result = f.core.sendRuntimeMessage(f.runtime, {}, 100);
  const rejected = assert.rejects(result, /timeout/);
  f.tick(10000);
  await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test("timeout consumes a late lastError without sending again", async () => {
  let callback;
  const f = fixture((_runtime, cb) => { callback = cb; });
  const result = f.core.sendRuntimeMessage(f.runtime, {}, 100);
  const rejected = assert.rejects(result, /timeout/);
  f.tick(100);
  await rejected;
  let reads = 0;
  Object.defineProperty(f.runtime, "lastError", { get() { reads++; return { message: "Receiving end does not exist." }; } });
  callback();
  f.tick(10000);
  assert.equal(reads, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test("provider error responses pass through without transport retries", async () => {
  const response = { ok: false, errors: [{ message: "quota exceeded" }] };
  const f = fixture((_runtime, callback) => callback(response));
  assert.equal(await f.core.sendRuntimeMessage(f.runtime, {}, 10000), response);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test("empty responses do not cause automatic paid request replays", async () => {
  const f = fixture((_runtime, callback) => callback());
  await assert.rejects(f.core.sendRuntimeMessage(f.runtime, {}, 10000), /未返回结果/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});
