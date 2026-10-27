import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeliveryError } from "./deliver.js";
import { HoldQueue, holdRetryDelayMs, type HeldItem, type HoldUi } from "./hold.js";
import { HttpWakeHook } from "./wake.js";
import { silentLogger, type DeliveryResult } from "./types.js";
import { mockRoutine, tmp, until } from "../test/helpers.js";

function recorder() {
  const events: string[] = [];
  const ui: HoldUi = {
    holding: async (i) => {
      events.push(`holding:${i.id}`);
      return `status-${i.id}`;
    },
    delivered: async (i, _r, info) => void events.push(`delivered:${i.id}:held=${info.held}`),
    failed: async (i, _e, info) => void events.push(`failed:${i.id}:held=${info.held}:expired=${info.expired}`),
  };
  return { events, ui };
}

const input = (id: string, lane = "l1") => ({ id, adapter: "test", lane, agent: "a", request: { agentId: "x", prompt: `p-${id}` } });

test("backoff: 5s, 10s, 20s, then every 30s", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(holdRetryDelayMs), [5000, 10000, 20000, 30000, 30000]);
});

test("retryable failure holds, persists, retries, then delivers", async () => {
  const dir = tmp();
  const file = join(dir, "hold.json");
  const { events, ui } = recorder();
  let calls = 0;
  let persistedWhileHeld = false;
  const q = new HoldQueue({
    filePath: file,
    maxMs: 60_000,
    ui,
    log: silentLogger,
    delayMs: () => 20,
    send: async (): Promise<DeliveryResult> => {
      calls += 1;
      if (calls < 3) {
        if (existsSync(file)) persistedWhileHeld ||= JSON.parse(readFileSync(file, "utf8")).items.length === 1;
        throw new DeliveryError("delivery HTTP 530", 530, "error code: 1033");
      }
      return { status: 200, body: { success: true } };
    },
  });
  await q.submit(input("a"));
  await until(() => events.some((e) => e.startsWith("delivered")));
  assert.deepEqual(events, ["holding:a", "delivered:a:held=true"]);
  assert.equal(calls, 3);
  assert.equal(persistedWhileHeld, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).items.length, 0);
  q.stop();
});

test("wake failure keeps holding; delivery still succeeds when the computer comes back", async () => {
  const wakeSrv = await mockRoutine({ script: [500] });
  const { events, ui } = recorder();
  const wake = new HttpWakeHook({ url: wakeSrv.url, key: "wk", log: silentLogger });
  let calls = 0;
  const q = new HoldQueue({
    filePath: "",
    maxMs: 60_000,
    ui,
    wake,
    log: silentLogger,
    delayMs: () => 30,
    send: async () => {
      calls += 1;
      if (calls < 4) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return { status: 200, body: {} };
    },
  });
  try {
    await q.submit(input("w"));
    await wake.lastPost;
    assert.equal(wakeSrv.hits.length, 1, "one wake POST per outage");
    assert.equal(wakeSrv.hits[0].headers.authorization, "Bearer wk");
    assert.deepEqual(Object.keys(wakeSrv.hits[0].body).sort(), ["firstHeldAt", "heldCount", "reason"]);
    assert.equal(q.heldCount(), 1, "still held after the wake failed");
    await until(() => events.some((e) => e.startsWith("delivered")));
    assert.equal(wakeSrv.hits.length, 1, "no second wake during the same outage");
    assert.equal(wake.armed, true, "re-armed after success");
  } finally {
    q.stop();
    await wakeSrv.close();
  }
});

test("non-retryable failure fails fast without holding", async () => {
  const { events, ui } = recorder();
  const q = new HoldQueue({
    filePath: "",
    maxMs: 60_000,
    ui,
    log: silentLogger,
    send: async () => {
      throw new DeliveryError("delivery HTTP 401", 401);
    },
  });
  await q.submit(input("x"));
  assert.deepEqual(events, ["failed:x:held=false:expired=false"]);
});

test("hold window runs out: gives up with the held flag", async () => {
  const { events, ui } = recorder();
  let t = 0;
  const q = new HoldQueue({
    filePath: "",
    maxMs: 100,
    now: () => t,
    ui,
    log: silentLogger,
    delayMs: () => 5,
    send: async () => {
      t += 60;
      throw new DeliveryError("delivery HTTP 503", 503);
    },
  });
  await q.submit(input("e"));
  await until(() => events.some((e) => e.startsWith("failed")));
  assert.deepEqual(events, ["holding:e", "failed:e:held=true:expired=true"]);
  q.stop();
});

test("events in one lane stay in order behind a held event; other lanes are not blocked", async () => {
  const { events, ui } = recorder();
  let down = true;
  const order: string[] = [];
  const q = new HoldQueue({
    filePath: "",
    maxMs: 60_000,
    ui,
    log: silentLogger,
    delayMs: () => 20,
    send: async (i: HeldItem) => {
      if (down && i.lane === "l1") throw new DeliveryError("delivery HTTP 502", 502);
      order.push(i.id);
      return { status: 200, body: {} };
    },
  });
  await q.submit(input("first", "l1"));
  await q.submit(input("second", "l1"));
  await q.submit(input("other", "l2"));
  assert.deepEqual(order, ["other"]);
  assert.ok(events.includes("holding:second"));
  down = false;
  await until(() => order.length === 3);
  assert.deepEqual(order, ["other", "first", "second"]);
  q.stop();
});

test("restart: held events reload from the file and are retried; expired ones fail", async () => {
  const file = join(tmp(), "hold.json");
  const now = Date.now();
  const mk = (id: string, deadline: number) => ({ ...input(id), seq: id === "live" ? 1 : 2, submittedAt: now - 1000, deadline, holding: true, tries: 2, failures: 2, lane: `lane-${id}` });
  writeFileSync(file, JSON.stringify({ version: 1, items: [mk("live", now + 60_000), mk("dead", now - 1)] }));
  const { events, ui } = recorder();
  const delivered: string[] = [];
  const q = new HoldQueue({
    filePath: file,
    maxMs: 60_000,
    ui,
    log: silentLogger,
    send: async (i) => {
      delivered.push(i.id);
      return { status: 200, body: {} };
    },
  });
  const r = await q.load();
  assert.deepEqual(r, { kept: 1, expired: 1 });
  await until(() => delivered.length === 1);
  assert.deepEqual(delivered, ["live"]);
  assert.ok(events.includes("failed:dead:held=true:expired=true"));
  q.stop();
});
