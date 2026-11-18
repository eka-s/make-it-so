import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createCrewModelsRouter, type CrewModelsRouterDeps } from "./crew-models.js";
import type { CrewMemberConfig } from "../fleet-config.js";

const member = (overrides: Partial<CrewMemberConfig> = {}): CrewMemberConfig => ({
  name: "Test", rank: "crew", provider: "claude", cwd: "/", rules: [], skills: [], ...overrides,
});
const OPTIONS = [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }];

/** Mounts the router on a real HTTP server and calls it with fake dependencies. */
async function setup(overrides: Partial<CrewModelsRouterDeps> = {}) {
  const overridesStore = new Map<string, string>();
  const applyModel = vi.fn(async () => {});
  const deps: CrewModelsRouterDeps = {
    crew: { first_officer: member({ name: "Alex" }), chief_engineer: member({ name: "Sam", model: "opus" }), kiro_crew: member({ provider: "kiro" }) },
    defaultProvider: "kiro",
    crewManager: {
      getModelOptions: (provider) => (provider === "claude" ? OPTIONS : []),
      getLiveModel: () => undefined,
      applyModel,
    },
    missionExists: (id) => id === "m1",
    getOverride: (m, r) => overridesStore.get(`${m}/${r}`),
    setOverride: (m, r, model) => { if (model === null) overridesStore.delete(`${m}/${r}`); else overridesStore.set(`${m}/${r}`, model); },
    taskScope: (m) => `__tasks__:${m}`,
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(createCrewModelsRouter(deps));
  const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, applyModel, close: () => server.close() };
}

const put = (base: string, role: string, body: unknown, mission = "m1") =>
  fetch(`${base}/api/missions/${mission}/crew-models/${role}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("crew-models route", () => {
  it("GET: returns the configured model, where it comes from, and the selectable list (an unsupported provider has an empty list)", async () => {
    const { base, close } = await setup();
    const list = await (await fetch(`${base}/api/missions/m1/crew-models`)).json();
    expect(list.find((e: { role: string }) => e.role === "first_officer")).toMatchObject({ effective: null, source: "default", options: OPTIONS });
    expect(list.find((e: { role: string }) => e.role === "chief_engineer")).toMatchObject({ effective: "opus", source: "config" });
    expect(list.find((e: { role: string }) => e.role === "kiro_crew").options).toEqual([]);
    close();
  });

  it("GET: a nonexistent mission is 404", async () => {
    const { base, close } = await setup();
    expect((await fetch(`${base}/api/missions/nope/crew-models`)).status).toBe(404);
    close();
  });

  it("PUT: saves the override and applies it to the running session, and GET shows the source = mission", async () => {
    const { base, applyModel, close } = await setup();
    const res = await put(base, "chief_engineer", { model: "sonnet" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "chief_engineer", effective: "sonnet", source: "mission" });
    expect(applyModel).toHaveBeenCalledWith("chief_engineer", "m1", "__tasks__:m1", "sonnet");
    close();
  });

  it("PUT null: removes the override and goes back to the configured model (if none is configured, undefined is passed to go back to the original model)", async () => {
    const { base, applyModel, close } = await setup();
    await put(base, "chief_engineer", { model: "sonnet" });
    const res = await put(base, "chief_engineer", { model: null });
    expect(await res.json()).toMatchObject({ effective: "opus", source: "config" });
    expect(applyModel).toHaveBeenLastCalledWith("chief_engineer", "m1", "__tasks__:m1", "opus");

    await put(base, "first_officer", { model: "opus" });
    await put(base, "first_officer", { model: null });
    expect(applyModel).toHaveBeenLastCalledWith("first_officer", "m1", "__tasks__:m1", undefined);
    close();
  });

  it("PUT: rejects invalid input (unknown role 404, unknown mission 404, unknown model 400, unsupported 409)", async () => {
    const { base, close } = await setup();
    expect((await put(base, "ghost", { model: "opus" })).status).toBe(404);
    expect((await put(base, "first_officer", { model: "opus" }, "nope")).status).toBe(404);
    expect((await put(base, "first_officer", { model: "gpt" })).status).toBe(400);
    expect((await put(base, "first_officer", { model: 5 })).status).toBe(400);
    expect((await put(base, "first_officer", {})).status).toBe(400);
    expect((await put(base, "kiro_crew", { model: "opus" })).status).toBe(409);
    close();
  });

  it("PUT: saving succeeds even if applying it to the session fails", async () => {
    const { base, close } = await setup({
      crewManager: { getModelOptions: () => OPTIONS, getLiveModel: () => undefined, applyModel: vi.fn(async () => { throw new Error("boom"); }) },
    });
    const res = await put(base, "first_officer", { model: "opus" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ effective: "opus", source: "mission" });
    close();
  });
});
