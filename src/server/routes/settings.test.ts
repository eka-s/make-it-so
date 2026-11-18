import { beforeEach, describe, expect, it, vi } from "vitest";
import { startTestServer } from "../testing/http.js";
import { createSettingsRouter } from "./settings.js";

const setLanguage = vi.fn();
const setCrewLanguage = vi.fn();
const deps = { setLanguage, setCrewLanguage };

beforeEach(() => { setLanguage.mockClear(); setCrewLanguage.mockClear(); });

describe("PUT /api/config/language", () => {
  it("saves a supported language and returns it", async () => {
    const server = await startTestServer((app) => app.use(createSettingsRouter(deps)));
    const { status, body } = await server.send("PUT", "/api/config/language", { language: "ja" });
    expect(status).toBe(200);
    expect(body).toEqual({ language: "ja" });
    expect(setLanguage).toHaveBeenCalledWith("ja");
    expect(setCrewLanguage).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects an unsupported or missing language with 400 and saves nothing", async () => {
    const server = await startTestServer((app) => app.use(createSettingsRouter(deps)));
    for (const body of [{ language: "fr" }, { language: 1 }, {}]) {
      const res = await server.send("PUT", "/api/config/language", body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_language" });
    }
    expect(setLanguage).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("PUT /api/config/crew-language", () => {
  it("saves the crew language only, leaving the UI language alone", async () => {
    const server = await startTestServer((app) => app.use(createSettingsRouter(deps)));
    const { status, body } = await server.send("PUT", "/api/config/crew-language", { language: "ja" });
    expect(status).toBe(200);
    expect(body).toEqual({ language: "ja" });
    expect(setCrewLanguage).toHaveBeenCalledWith("ja");
    expect(setLanguage).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects an unsupported language with 400 and saves nothing", async () => {
    const server = await startTestServer((app) => app.use(createSettingsRouter(deps)));
    const res = await server.send("PUT", "/api/config/crew-language", { language: "fr" });
    expect(res.status).toBe(400);
    expect(setCrewLanguage).not.toHaveBeenCalled();
    await server.close();
  });
});
