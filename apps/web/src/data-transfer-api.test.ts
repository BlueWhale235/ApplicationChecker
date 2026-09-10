import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "./api";

const { api } = apiModule;

afterEach(() => vi.unstubAllGlobals());

describe("data transfer API", () => {
  it("defaults to all sections and removes screenshots when application data is disabled", () => {
    const transferHelpers = apiModule as typeof apiModule & {
      defaultDataTransferSections(): string[];
      normalizeDataTransferSections(sections: string[]): string[];
    };
    expect(transferHelpers.defaultDataTransferSections()).toEqual([
      "application_data", "screenshots", "system_settings", "browser_state",
    ]);
    expect(transferHelpers.normalizeDataTransferSections(["screenshots", "system_settings"]))
      .toEqual(["system_settings"]);
  });

  it("sends the selected export sections to the server", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "stop after request capture" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.exportAllData("export-password", "export-password", ["application_data", "system_settings"]))
      .rejects.toThrow("stop after request capture");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      password: "export-password",
      passwordConfirmation: "export-password",
      sections: ["application_data", "system_settings"],
    });
  });
});
