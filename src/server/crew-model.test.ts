import { describe, expect, it } from "vitest";
import { parseAgentValues, parseModeValues, parseModelState, resolveCrewModel } from "./crew-model.js";

describe("resolveCrewModel", () => {
  it("the mission override has top priority", () => {
    expect(resolveCrewModel({ override: "haiku", configured: "opus" })).toEqual({ model: "haiku", source: "mission" });
  });
  it("without an override, the configuration (the value with ship/roster already merged)", () => {
    expect(resolveCrewModel({ configured: "opus" })).toEqual({ model: "opus", source: "config" });
  });
  it("if neither exists, the provider's default", () => {
    expect(resolveCrewModel({})).toEqual({ model: undefined, source: "default" });
    expect(resolveCrewModel({ override: null, configured: "" })).toEqual({ model: undefined, source: "default" });
  });
});

describe("parseAgentValues", () => {
  it("extracts the values of the agent options (mode values are not mixed in). An empty array if none", () => {
    const response = {
      configOptions: [
        { id: "mode", options: [{ value: "auto" }] },
        { id: "agent", options: [{ value: "default" }, { value: "scout" }] },
      ],
    };
    expect(parseAgentValues(response)).toEqual(["default", "scout"]);
    expect(parseAgentValues({ configOptions: [{ id: "mode", options: [{ value: "auto" }] }] })).toEqual([]);
    expect(parseAgentValues(null)).toEqual([]);
  });
});

describe("parseModeValues", () => {
  it("extracts the values of the mode options. An empty array if none", () => {
    const response = { configOptions: [{ id: "mode", options: [{ value: "default" }, { value: "auto" }] }, { id: "model", options: [] }] };
    expect(parseModeValues(response)).toEqual(["default", "auto"]);
    expect(parseModeValues({ configOptions: [] })).toEqual([]);
    expect(parseModeValues({})).toEqual([]);
    expect(parseModeValues(null)).toEqual([]);
  });
});

describe("parseModelState", () => {
  // A shortened version of a real machine's (claude-agent-acp) session/new response
  const response = {
    sessionId: "s1",
    configOptions: [
      { id: "mode", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }] },
      {
        id: "model",
        type: "select",
        currentValue: "sonnet",
        options: [
          { value: "default", name: "Default (recommended)" },
          { value: "sonnet", name: "Sonnet 5.5" },
        ],
      },
    ],
  };

  it("extracts the current value of model and the options", () => {
    expect(parseModelState(response)).toEqual({
      current: "sonnet",
      options: [
        { value: "default", name: "Default (recommended)" },
        { value: "sonnet", name: "Sonnet 5.5" },
      ],
    });
  });
  it("null if there is no model item (kiro etc.) or the shape is unexpected", () => {
    expect(parseModelState({ sessionId: "s1" })).toBeNull();
    expect(parseModelState({ configOptions: [response.configOptions[0]] })).toBeNull();
    expect(parseModelState({ configOptions: [{ id: "model", currentValue: 1, options: [] }] })).toBeNull();
    expect(parseModelState(null)).toBeNull();
  });
});
