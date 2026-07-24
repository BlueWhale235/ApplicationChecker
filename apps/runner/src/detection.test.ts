import { describe, expect, it } from "vitest";
import { classifyPage } from "./detection.js";

const base = { title: "Application", text: "Your application is under review", status: 200, passwordFields: 0, otpFields: 0, captchaElements: 0 };

describe("login detection", () => {
  it("flags login URLs and password forms", () => {
    expect(classifyPage({ ...base, url: "https://example.com/login" }).requiresLogin).toBe(true);
    expect(classifyPage({ ...base, url: "https://example.com/jobs", passwordFields: 1 }).reason).toBe("login_required");
  });
  it("allows a normal status page", () => {
    expect(classifyPage({ ...base, url: "https://example.com/applications/1" }).requiresLogin).toBe(false);
  });
});
