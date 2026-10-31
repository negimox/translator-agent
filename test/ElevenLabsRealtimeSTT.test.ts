import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RealtimeEvents } from "@elevenlabs/elevenlabs-js";
import { ElevenLabsRealtimeSTT } from "../src/providers/elevenlabs/ElevenLabsRealtimeSTT";

class FakeConnection extends EventEmitter {
  lastConnectArgs: Record<string, unknown> = {};
  send(): void {}
  commit(): void {}
  close(): void {
    this.emit(RealtimeEvents.CLOSE, {});
  }
}

type ConnectImpl = (args: Record<string, unknown>) => Promise<FakeConnection>;

function makeSTT(
  connectImpl: ConnectImpl,
  config: Record<string, unknown> = {},
): ElevenLabsRealtimeSTT {
  const stt = new ElevenLabsRealtimeSTT({ apiKey: "k", ...config });
  (stt as any).client = {
    speechToText: {
      realtime: {
        connect: async (args: Record<string, unknown>) => {
          const conn = await connectImpl(args);
          conn.lastConnectArgs = args;
          return conn;
        },
      },
    },
  };
  return stt;
}

/** Let promise continuations settle (mock timers do not fake microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function tick(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await settle();
}

const RETRY_CONFIG = { maxReconnectAttempts: 3, reconnectDelayMs: 1000 };

afterEach(() => {
  mock.timers.reset();
});

// ─── Task 3: language from timestamped event ───

test("connects with includeTimestamps and no languageCode when none configured", async () => {
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  await stt.connect();
  assert.equal(conn.lastConnectArgs.includeTimestamps, true);
  assert.equal("languageCode" in conn.lastConnectArgs, false);
  stt.disconnect();
});

test("passes languageCode when configured", async () => {
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn, { languageCode: "hi" });
  await stt.connect();
  assert.equal(conn.lastConnectArgs.languageCode, "hi");
  stt.disconnect();
});

test("emits committed once, with language from the timestamped event", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();

  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello" });
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, {
    text: "hello",
    language_code: "eng",
  });
  assert.deepEqual(events, [{ text: "hello", language: "eng" }]);

  // The fallback timer must not produce a second emit.
  await tick(5000);
  assert.deepEqual(events, [{ text: "hello", language: "eng" }]);
  stt.disconnect();
});

test("plain-only transcript falls back after timestampedWaitMs with empty language", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn, { timestampedWaitMs: 1000 });
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();

  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello" });
  assert.deepEqual(events, []);
  await tick(999);
  assert.deepEqual(events, []);
  await tick(1);
  assert.deepEqual(events, [{ text: "hello", language: "" }]);
  await tick(5000);
  assert.equal(events.length, 1);
  stt.disconnect();
});

test("late timestamped event after the fallback emit is dropped", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();

  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello" });
  await tick(1000);
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, {
    text: "hello",
    language_code: "eng",
  });
  assert.deepEqual(events, [{ text: "hello", language: "" }]);
  stt.disconnect();
});

test("timestamped event with no pending plain entry is emitted directly", async () => {
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();

  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, { text: "hi" });
  assert.deepEqual(events, [{ text: "hi", language: "" }]);
  stt.disconnect();
});

test("disconnect clears the pending fallback timer", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();

  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello" });
  stt.disconnect();
  await tick(5000);
  assert.deepEqual(events, []);
});

// ─── Task 4: reliable reconnect ───

test("retries after a failed reconnect handshake", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conns: FakeConnection[] = [];
  let calls = 0;
  const stt = makeSTT(async () => {
    calls++;
    if (calls === 1 || calls === 4) {
      const c = new FakeConnection();
      conns.push(c);
      return c;
    }
    throw new Error("handshake failed");
  }, RETRY_CONFIG);
  let reconnected = 0;
  let closed = 0;
  stt.on("reconnected", () => reconnected++);
  stt.on("close", () => closed++);

  await stt.connect();
  conns[0].close();
  await tick(1000); // attempt 1 fails
  await tick(2000); // attempt 2 fails
  await tick(4000); // attempt 3 succeeds
  assert.equal(calls, 4);
  assert.equal(reconnected, 1);
  assert.equal(closed, 0);
  assert.equal(stt.isConnected(), true);
  stt.disconnect();
});

test("initial connect failure schedules a retry", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const stt = makeSTT(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return new FakeConnection();
  }, RETRY_CONFIG);

  await assert.rejects(stt.connect());
  assert.equal(stt.isConnected(), false);
  await tick(1000);
  assert.equal(stt.isConnected(), true);
  assert.equal(calls, 2);
  stt.disconnect();
});

test("open-then-close loop gives up after maxReconnectAttempts", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const stt = makeSTT(async () => {
    calls++;
    const c = new FakeConnection();
    // Close immediately after the handshake resolves (elapsed < stableSessionMs).
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => c.close())));
    return c;
  }, RETRY_CONFIG);
  let closed = 0;
  stt.on("close", () => closed++);

  await stt.connect();
  await settle();
  for (let i = 0; i < 6; i++) await tick(10_000);
  assert.equal(calls, 1 + 3);
  assert.equal(closed, 1);
});

test("a session longer than stableSessionMs resets the attempt budget", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conns: FakeConnection[] = [];
  const stt = makeSTT(async () => {
    const c = new FakeConnection();
    conns.push(c);
    return c;
  }, RETRY_CONFIG);
  let closed = 0;
  stt.on("close", () => closed++);

  await stt.connect();
  for (let i = 0; i < 4; i++) {
    await tick(11_000); // stable session
    conns[conns.length - 1].close();
    await tick(1000); // first-attempt backoff after the reset
  }
  assert.equal(closed, 0);
  assert.equal(conns.length, 5);
  assert.equal(stt.isConnected(), true);
  stt.disconnect();
});

test("connect after disconnect re-enables reconnect", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conns: FakeConnection[] = [];
  const stt = makeSTT(async () => {
    const c = new FakeConnection();
    conns.push(c);
    return c;
  }, RETRY_CONFIG);

  await stt.connect();
  stt.disconnect();
  await stt.connect();
  const before = conns.length;
  conns[conns.length - 1].close();
  await tick(1000);
  assert.equal(conns.length, before + 1);
  stt.disconnect();
});

// ─── Review follow-ups ───

test("a plain event arriving after its directly-emitted timestamped twin is dropped", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, { text: "hello there", language_code: "eng" });
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello there" });
  await tick(5000);
  assert.deepEqual(events, [{ text: "hello there", language: "eng" }]);
  stt.disconnect();
});

test("twin events that differ only in whitespace are paired", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = new FakeConnection();
  const stt = makeSTT(async () => conn);
  const events: unknown[] = [];
  stt.on("committed", (e) => events.push(e));
  await stt.connect();
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: "hello  there " });
  conn.emit(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, { text: "hello there", language_code: "eng" });
  await tick(5000);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { language: string }).language, "eng");
  stt.disconnect();
});

test("a connect that finishes after disconnect() is closed, not leaked", async () => {
  const conn = new FakeConnection();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stt = makeSTT(async () => {
    await gate;
    return conn;
  });
  const pending = stt.connect();
  stt.disconnect();
  release();
  await pending;
  assert.equal(stt.isConnected(), false);
});

test("a stale CLOSE from an old connection does not tear down the new one", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = new FakeConnection();
  const second = new FakeConnection();
  const queue = [first, second];
  const stt = makeSTT(async () => queue.shift()!, RETRY_CONFIG);
  await stt.connect();
  first.close(); // server drop -> reconnect scheduled
  await tick(1000);
  assert.equal(stt.isConnected(), true);
  first.emit(RealtimeEvents.CLOSE, {}); // late duplicate CLOSE from the dead socket
  await tick(5000);
  assert.equal(stt.isConnected(), true);
  stt.disconnect();
});

test("disconnect() gives a later connect() a fresh reconnect budget", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conns: FakeConnection[] = [];
  let failing = false;
  const stt = makeSTT(async () => {
    if (failing) throw new Error("down");
    const c = new FakeConnection();
    conns.push(c);
    return c;
  }, { maxReconnectAttempts: 2, reconnectDelayMs: 1000 });
  let closes = 0;
  stt.on("close", () => closes++);
  await stt.connect();
  failing = true;
  conns[0].close();
  await tick(1000);
  await tick(2000);
  await tick(4000); // budget exhausted -> gave up
  assert.equal(closes, 1);
  stt.disconnect();
  failing = false;
  await stt.connect();
  failing = true;
  conns[conns.length - 1].close();
  await tick(1000); // must retry again rather than give up at once
  assert.equal(closes, 1);
  stt.disconnect();
});
