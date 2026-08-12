import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScriptRuleApplication, SelectorParserRuleDefinition } from "@application-checker/contracts";
import { runSelectorRuleInPage } from "./script-selector-rule.js";

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: Array<FakeElement | { nodeType: number; textContent: string }> = [];
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  readonly classList: { contains: (token: string) => boolean };
  constructor(
    readonly tagName: string,
    readonly text: string,
    readonly classes: string[],
    readonly rect: { x: number; y: number; width: number; height: number },
  ) {
    this.classList = { contains: (token) => this.classes.includes(token) };
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }
  get textContent(): string { return this.text || this.children.map((child) => child.textContent).join(" "); }
  get innerText(): string { return this.textContent; }
  get childElementCount(): number { return this.children.length; }
  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
      this.childNodes.push(child);
    }
    return this;
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== "*") throw new Error(`unsupported selector: ${selector}`);
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
}

const locator = (classes: string[]) => ({
  tag: "div", role: null, classes, dataStatus: null, ariaCurrent: null, ariaSelected: null, ancestorTags: [],
});
const definition: SelectorParserRuleDefinition = {
  schemaVersion: 2,
  kind: "selector",
  hostname: "careers.example.com",
  pathname: "/applications/*",
  container: locator(["application-card"]),
  title: locator(["job-title"]),
  status: locator(["job-status"]),
};
const applications: ScriptRuleApplication[] = [
  { id: "job-1", company: "示例公司", jobTitle: "国内客户经理", checkUrl: null, postingUrl: null, appliedAt: null, location: null, notes: null, site: "example.com", progressStatus: "unset" },
  { id: "job-2", company: "示例公司", jobTitle: "销售专员", checkUrl: null, postingUrl: null, appliedAt: null, location: null, notes: null, site: "example.com", progressStatus: "unset" },
];

function card(y: number, title: string, status: string, extraStatus?: string): FakeElement {
  const item = new FakeElement("DIV", "", ["application-card"], { x: 10, y, width: 600, height: 110 });
  item.append(
    new FakeElement("DIV", title, ["job-title"], { x: 20, y: y + 10, width: 300, height: 30 }),
    new FakeElement("DIV", status, ["job-status"], { x: 20, y: y + 50, width: 160, height: 30 }),
  );
  if (extraStatus) item.append(new FakeElement("DIV", extraStatus, ["job-status"], { x: 200, y: y + 50, width: 160, height: 30 }));
  return item;
}

function installPage(...cards: FakeElement[]): void {
  const body = new FakeElement("BODY", "", [], { x: 0, y: 0, width: 1_000, height: 1_000 }).append(...cards);
  vi.stubGlobal("document", { body });
  vi.stubGlobal("window", { scrollY: 0 });
  vi.stubGlobal("location", new URL("https://careers.example.com/applications/history"));
  vi.stubGlobal("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
}

afterEach(() => vi.unstubAllGlobals());

describe("embedded selector rules", () => {
  it("matches exact and uniquely-contained titles in separate cards", () => {
    installPage(
      card(0, "第 1 志愿 国内客户经理", "投递成功"),
      card(140, "销售专员", "暂不匹配"),
    );
    expect(runSelectorRuleInPage(definition, applications)).toMatchObject([
      { applicationId: "job-1", rawStatus: "投递成功" },
      { applicationId: "job-2", rawStatus: "暂不匹配" },
    ]);
  });

  it("omits ambiguous titles and status texts instead of guessing", () => {
    installPage(
      card(0, "国内客户经理", "投递成功", "待面试"),
      card(140, "销售专员", "投递成功"),
      card(280, "销售专员", "待面试"),
    );
    expect(runSelectorRuleInPage(definition, applications)).toEqual([]);
  });

  it("returns an empty result outside the embedded URLPattern", () => {
    installPage(card(0, "国内客户经理", "投递成功"));
    expect(runSelectorRuleInPage({ ...definition, pathname: "/other/*" }, applications)).toEqual([]);
  });

  it.each([
    [{ ...definition, kind: "script" }, /kind/],
    [{ ...definition, title: { ...definition.title, classes: ["a", "b", "c", "d", "e"] } }, /层级超过限制/],
    [{ ...definition, status: { ...definition.status, dataStatus: "<script>" } }, /不安全内容/],
    [{ ...definition, hostname: "bad{host" }, /hostname/],
  ])("rejects invalid or unsafe selector JSON", (value, expected) => {
    installPage();
    expect(() => runSelectorRuleInPage(value, applications)).toThrow(expected);
  });
});
