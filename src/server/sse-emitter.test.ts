import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { SSEEvent } from "./types.js";
import { addConnection, broadcast, getConnectionCount, removeConnection } from "./sse-emitter.js";

// A fake that imitates only the part of express's Response that sse-emitter uses.
function fakeResponse() {
  const handlers: Record<string, () => void> = {};
  // A flag to reproduce a connection that breaks "after" the connection is established.
  const state = { broken: false };
  const res = {
    writeHead: vi.fn(),
    write: vi.fn(() => {
      if (state.broken) throw new Error("broken pipe");
      return true;
    }),
    on: vi.fn((event: string, fn: () => void) => {
      handlers[event] = fn;
    }),
    writableLength: 0,
    // Destroying a real response ends the socket and then emits "close".
    destroy: vi.fn(() => { handlers.close?.(); }),
  };
  return { res, state, asResponse: res as unknown as Response, close: () => handlers.close?.() };
}

// Connections are module-level state, so every one is removed in each test to keep them independent.
const ids: string[] = [];
function connect(channel: string, opts?: { writeThrows?: boolean }) {
  const fake = fakeResponse();
  const id = addConnection(fake.asResponse, channel);
  ids.push(id);
  // What happens right after connecting (": connected" etc.) is not under test, so clear the call history
  fake.res.write.mockClear();
  // Breaks after the connection is established (the client went down, the pipe broke, etc.)
  if (opts?.writeThrows) fake.state.broken = true;
  return { ...fake, id };
}

afterEach(() => {
  for (const id of ids.splice(0)) removeConnection(id);
  vi.useRealTimers();
});

const upsert = { type: "timeline:upsert", data: { id: "x" } } as unknown as SSEEvent;
const written = (res: { write: ReturnType<typeof vi.fn> }) => res.write.mock.calls.map((c) => String(c[0])).join("");

describe("sse-emitter", () => {
  it("sets the SSE headers on connection", () => {
    const fake = fakeResponse();
    ids.push(addConnection(fake.asResponse, "bridge"));
    expect(fake.res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
  });

  it("events are delivered in the SSE format (id/event/data)", () => {
    const c = connect("bridge");
    broadcast(upsert);
    const out = written(c.res);
    expect(out).toMatch(/^id: \d+\nevent: timeline:upsert\ndata: \{"id":"x"\}\n\n$/);
  });

  it("chat events reach only the bridge and all channels, not other channels", () => {
    const bridge = connect("bridge");
    const all = connect("all");
    const crew = connect("chief_engineer");

    broadcast(upsert);

    expect(bridge.res.write).toHaveBeenCalledTimes(1);
    expect(all.res.write).toHaveBeenCalledTimes(1);
    expect(crew.res.write).not.toHaveBeenCalled();
  });

  it("an event addressed to an agent reaches that agent's channel", () => {
    const eng = connect("chief_engineer");
    const sec = connect("security_officer");

    broadcast({
      type: "task:progress",
      data: { agent: "chief_engineer", taskId: "chief_engineer_0001", chunk: "x", field: "response" },
    } as SSEEvent);

    expect(eng.res.write).toHaveBeenCalledTimes(1);
    expect(sec.res.write).not.toHaveBeenCalled();
  });

  it("the id increases with every delivery", () => {
    const c = connect("bridge");
    broadcast(upsert);
    broadcast(upsert);
    const ids = [...written(c.res).matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0] + 1);
  });

  it("closing a connection removes it", () => {
    const before = getConnectionCount();
    const c = connect("bridge");
    expect(getConnectionCount()).toBe(before + 1);
    c.close();
    expect(getConnectionCount()).toBe(before);
  });

  it("a connection whose write throws is removed on delivery (others still receive it)", () => {
    const before = getConnectionCount();
    connect("bridge", { writeThrows: true });
    const healthy = connect("bridge");

    broadcast(upsert);

    expect(getConnectionCount()).toBe(before + 1);
    expect(healthy.res.write).toHaveBeenCalledTimes(1);
  });

  it("a connection that is dropped is also closed, so that the browser reconnects instead of waiting on a dead stream", () => {
    const broken = connect("bridge", { writeThrows: true });
    broadcast(upsert);
    expect(broken.res.destroy).toHaveBeenCalled();
  });

  it("a slow client (write returns false) is kept while its buffer is small, and closed once too much is waiting", () => {
    const before = getConnectionCount();
    const slow = connect("bridge");
    slow.res.write.mockImplementation(() => false);
    broadcast(upsert);
    expect(slow.res.destroy).not.toHaveBeenCalled();
    expect(getConnectionCount()).toBe(before + 1);

    slow.res.writableLength = 2 * 1024 * 1024;
    broadcast(upsert);
    expect(slow.res.destroy).toHaveBeenCalled();
    expect(getConnectionCount()).toBe(before);
  });

  describe("heartbeat", () => {
    beforeEach(() => vi.useFakeTimers());

    it("sends a comment line every 15 seconds", () => {
      const c = connect("bridge");
      vi.advanceTimersByTime(15_000);
      expect(written(c.res)).toContain(": heartbeat");
    });

    it("a dead connection (write fails) is closed and removed by the heartbeat", () => {
      const before = getConnectionCount();
      const dead = connect("bridge", { writeThrows: true });
      vi.advanceTimersByTime(15_000);
      expect(getConnectionCount()).toBe(before);
      expect(dead.res.destroy).toHaveBeenCalled();
    });

    it("a momentary backpressure (write returns false) does not drop a healthy client", () => {
      const before = getConnectionCount();
      const c = connect("bridge");
      c.res.write.mockImplementation(() => false);
      vi.advanceTimersByTime(15_000);
      expect(getConnectionCount()).toBe(before + 1);
      expect(c.res.destroy).not.toHaveBeenCalled();
    });
  });
});
