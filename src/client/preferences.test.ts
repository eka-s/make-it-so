import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatTargetStorageKey,
  loadStoredActiveMissionId,
  loadStoredChatTarget,
  loadStoredNumber,
  loadStoredSearchGroupMode,
  persistSearchGroupMode,
  loadStoredTargetOrder,
  persistTargetOrder,
  persistActiveMissionId,
  persistChatTarget,
  persistNumber,
  loadStoredSplitEnabled,
  persistSplitEnabled,
} from "./preferences";

// A fake localStorage (to run outside a browser).
let store: Map<string, string>;
function stubStorage(overrides: Partial<Storage> = {}): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    ...overrides,
  });
}

beforeEach(() => {
  store = new Map();
  stubStorage();
});
afterEach(() => vi.unstubAllGlobals());

describe("how search results are grouped", () => {
  it("a saved value can be read back. If nothing is saved or the value is invalid, the default (by mission)", () => {
    expect(loadStoredSearchGroupMode()).toBe("mission");
    persistSearchGroupMode("crew");
    expect(loadStoredSearchGroupMode()).toBe("crew");
    store.set("search-group-mode", "nonsense");
    expect(loadStoredSearchGroupMode()).toBe("mission");
  });
});

describe("order of the conversation-partner buttons", () => {
  it("a saved order can be read back. Empty if nothing is saved", () => {
    expect(loadStoredTargetOrder()).toEqual([]);
    persistTargetOrder(["b", "a"]);
    expect(loadStoredTargetOrder()).toEqual(["b", "a"]);
  });

  it.each(["not json", "{}", "[1,2]", '["a",3]', ""])("a broken value (%s) is treated as empty", (raw) => {
    store.set("chat-target-order", raw);
    expect(loadStoredTargetOrder()).toEqual([]);
  });
});

describe("sizes that can be changed by dragging (width, height)", () => {
  it("a saved value can be read back. null if nothing is saved", () => {
    expect(loadStoredNumber("h")).toBeNull();
    persistNumber("h", 240);
    expect(loadStoredNumber("h")).toBe(240);
  });

  it.each(["abc", "0", "-5", ""])("an invalid value (%s) is null", (raw) => {
    store.set("h", raw);
    expect(loadStoredNumber("h")).toBeNull();
  });
});

describe("conversation partner per mission", () => {
  it("saved separately per mission (A→B→A does not lose it)", () => {
    persistChatTarget("m-a", "chief_engineer");
    persistChatTarget("m-b", "ensign");
    expect(loadStoredChatTarget("m-a")).toBe("chief_engineer");
    expect(loadStoredChatTarget("m-b")).toBe("ensign");
    expect(loadStoredChatTarget("m-c")).toBeNull();
  });

  it("the storage key includes the mission ID", () => {
    expect(chatTargetStorageKey("m1")).toBe("chat-default-target:m1");
  });

  it("an empty string is an invalid value, so null", () => {
    store.set(chatTargetStorageKey("m1"), "");
    expect(loadStoredChatTarget("m1")).toBeNull();
  });
});

describe("selected mission", () => {
  it("restores the saved value. If nothing is saved, or it is empty, the default mission", () => {
    expect(loadStoredActiveMissionId()).toBe("bridge");
    persistActiveMissionId("m42");
    expect(loadStoredActiveMissionId()).toBe("m42");
    store.set("active-mission-id", "");
    expect(loadStoredActiveMissionId()).toBe("bridge");
  });
});

describe("an environment where localStorage is unavailable (private browsing, etc.)", () => {
  beforeEach(() => {
    const boom = () => {
      throw new Error("denied");
    };
    stubStorage({ getItem: boom, setItem: boom });
  });

  it("reading falls back to the default and does not throw", () => {
    expect(loadStoredNumber("h")).toBeNull();
    expect(loadStoredChatTarget("m1")).toBeNull();
    expect(loadStoredTargetOrder()).toEqual([]);
    expect(loadStoredSearchGroupMode()).toBe("mission");
    expect(loadStoredActiveMissionId()).toBe("bridge");
  });

  it("writing is silently ignored and does not throw", () => {
    expect(() => persistNumber("h", 1)).not.toThrow();
    expect(() => persistChatTarget("m1", "x")).not.toThrow();
    expect(() => persistTargetOrder(["a"])).not.toThrow();
    expect(() => persistActiveMissionId("m1")).not.toThrow();
  });
});

describe("whether the conversation is split", () => {
  it("is off until it is turned on, and remembers the choice", () => {
    expect(loadStoredSplitEnabled()).toBe(false);
    persistSplitEnabled(true);
    expect(loadStoredSplitEnabled()).toBe(true);
    persistSplitEnabled(false);
    expect(loadStoredSplitEnabled()).toBe(false);
  });

  it("is off when localStorage is unavailable", () => {
    stubStorage({ getItem: () => { throw new Error("blocked"); } });
    expect(loadStoredSplitEnabled()).toBe(false);
  });
});
