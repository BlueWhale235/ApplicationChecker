import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleRecognizer, type AiDebugObserver } from "./index.js";

describe("recognizer configuration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is disabled unless every setting is provided", () => {
    expect(new OpenAiCompatibleRecognizer({}).configured).toBe(false);
    expect(new OpenAiCompatibleRecognizer({ baseUrl: "https://api.example/v1", apiKey: "x", model: "vision" }).configured).toBe(true);
  });

  it("requests and parses one JSON result set for multiple applications", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [
        {
          applicationId: "a", matched: true, rawStatus: "简历筛选-进行中",
          status: "screening", confidence: 0.94, evidence: "页面状态",
        },
        {
          applicationId: "b", matched: true, rawStatus: "业务筛选-进行中",
          status: "screening_passed", confidence: 0.91, evidence: "页面状态",
        },
      ] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const recognizer = new OpenAiCompatibleRecognizer({ baseUrl: "https://api.example/v1", apiKey: "x", model: "vision" });
    const result = await recognizer.recognizeGroup({
      screenshot: Buffer.from("png"),
      company: "示例公司",
      applications: [
        { id: "a", jobTitle: "岗位 A", appliedAt: null, location: null },
        { id: "b", jobTitle: "岗位 B", appliedAt: null, location: null },
      ],
      pageTitle: "投递记录",
      finalUrl: "https://example.com/status",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.results).toMatchObject([
      { applicationId: "a", status: "screening" },
      { applicationId: "b", status: "screening_passed" },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("业务筛选-进行中=screening_passed");
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]).toMatchObject({ role: "system" });
    expect(String(sent.messages[0]?.content)).toContain("业务筛选=screening_passed");
    expect(String(sent.messages[0]?.content)).toContain("简历筛选=screening");
    expect(String(sent.messages[0]?.content)).toContain("待评估=screening");
    expect(sent.messages[1]).toMatchObject({ role: "user" });
    expect(sent).not.toHaveProperty("previous_response_id");
  });

  it("reports sanitized lifecycle events to the optional debug observer", async () => {
    const responseBody = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        pageType: "application_status",
        pageEvidence: "投递记录",
        results: [{ applicationId: "a", matched: true, rawStatus: "待评估", status: "screening", confidence: 0.8, evidence: "状态列" }],
      }) } }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(responseBody, { status: 200 })));
    const observer = {
      start: vi.fn().mockReturnValue("trace-1"),
      attempt: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    } satisfies AiDebugObserver;
    const recognizer = new OpenAiCompatibleRecognizer({
      baseUrl: "https://api.example/v1",
      apiKey: "secret-key",
      model: "vision",
      debugObserver: observer,
    });
    await recognizer.recognizeGroup({
      screenshot: Buffer.from("png"),
      company: "示例公司",
      applications: [{ id: "a", jobTitle: "岗位 A", appliedAt: null, location: null }],
      pageTitle: "投递记录",
      finalUrl: "https://example.com/status",
      debugContext: { runId: "run-1", screenshotTruncated: true },
    });
    expect(observer.start).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      screenshotBytes: 3,
      screenshotTruncated: true,
      endpoint: "https://api.example/v1/chat/completions",
    }));
    expect(JSON.stringify(observer.start.mock.calls)).not.toContain("secret-key");
    expect(JSON.stringify(observer.start.mock.calls)).not.toContain(Buffer.from("png").toString("base64"));
    expect(observer.attempt).toHaveBeenCalledWith("trace-1", expect.objectContaining({ httpStatus: 200, responseBody }));
    expect(observer.complete).toHaveBeenCalledWith("trace-1", expect.objectContaining({
      pageType: "application_status",
      results: [expect.objectContaining({ status: "screening" })],
    }));
    expect(observer.fail).not.toHaveBeenCalled();
  });

  it("reports invalid JSON as a failed debug trace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const observer = {
      start: vi.fn().mockReturnValue("trace-2"),
      attempt: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    } satisfies AiDebugObserver;
    const recognizer = new OpenAiCompatibleRecognizer({
      baseUrl: "https://api.example/v1", apiKey: "x", model: "vision", debugObserver: observer,
    });
    await expect(recognizer.recognizeGroup({
      screenshot: Buffer.from("png"), company: "示例公司", applications: [], pageTitle: null, finalUrl: null,
    })).rejects.toThrow();
    expect(observer.attempt).toHaveBeenCalledWith("trace-2", expect.objectContaining({ httpStatus: 200 }));
    expect(observer.fail).toHaveBeenCalledWith("trace-2", expect.any(String));
  });

  it.each([
    ["official_homepage", "官网首页"],
    ["login", "登录页面"],
    ["blank", "页面没有有效内容"],
  ])("resets every application for a %s page", async (pageType, pageEvidence) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        pageType,
        pageEvidence,
        results: [{
          applicationId: "a",
          matched: true,
          rawStatus: "AI 错误推测",
          status: "rejected",
          confidence: 0.9,
          evidence: "不应采用",
        }],
      }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const recognizer = new OpenAiCompatibleRecognizer({ baseUrl: "https://api.example/v1", apiKey: "x", model: "vision" });
    const result = await recognizer.recognizeGroup({
      screenshot: Buffer.from("png"),
      company: "示例公司",
      applications: [
        { id: "a", jobTitle: "岗位 A", appliedAt: null, location: null },
        { id: "b", jobTitle: "岗位 B", appliedAt: null, location: null },
      ],
      pageTitle: pageEvidence,
      finalUrl: "https://example.com",
    });
    expect(result.results).toEqual([
      expect.objectContaining({ applicationId: "a", matched: true, status: "unset", confidence: 1, evidence: pageEvidence }),
      expect.objectContaining({ applicationId: "b", matched: true, status: "unset", confidence: 1, evidence: pageEvidence }),
    ]);
  });

  it("falls back to normal mode when deep thinking is rejected", async () => {
    const successBody = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [] }) } }],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("reasoning_effort is not supported", { status: 400 }))
      .mockResolvedValueOnce(new Response(successBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(successBody, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const recognizer = new OpenAiCompatibleRecognizer({
      baseUrl: "https://fallback.example/v1",
      apiKey: "x",
      model: "vision-without-reasoning",
      deepThinking: true,
    });
    await recognizer.recognizeGroup({
      screenshot: Buffer.from("png"),
      company: "示例公司",
      applications: [],
      pageTitle: null,
      finalUrl: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deepBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(deepBody).toMatchObject({ reasoning_effort: "high" });
    expect(deepBody).not.toHaveProperty("temperature");
    expect(fallbackBody).toMatchObject({ temperature: 0 });
    expect(fallbackBody).not.toHaveProperty("reasoning_effort");

    await recognizer.recognizeGroup({
      screenshot: Buffer.from("png"),
      company: "示例公司",
      applications: [],
      pageTitle: null,
      finalUrl: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rememberedFallbackBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as Record<string, unknown>;
    expect(rememberedFallbackBody).toMatchObject({ temperature: 0 });
    expect(rememberedFallbackBody).not.toHaveProperty("reasoning_effort");
  });
});
