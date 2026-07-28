import type { Page } from "puppeteer-core";
import type { LocalPageSnapshot } from "@application-checker/contracts";

const MAX_NODES = 5_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_NODE_TEXT_CHARS = 1_000;

export async function captureLocalPageSnapshot(page: Page): Promise<LocalPageSnapshot> {
  return page.evaluate(({ maxNodes, maxTextChars, maxNodeTextChars }) => {
    const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH"]);
    const elements = [...document.body.querySelectorAll("*")];
    const ids = new Map<Element, number>();
    const nodes: LocalPageSnapshot["nodes"] = [];
    let consumedText = 0;
    let textLimitReached = false;

    const clean = (value: string): string => value.replace(/\s+/g, " ").trim();
    const safeText = (element: Element): string => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        return "";
      }
      const ownText = [...element.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? "")
        .join(" ");
      const direct = clean(ownText);
      if (direct) return direct.slice(0, maxNodeTextChars);
      if (element.childElementCount <= 2) return clean((element as HTMLElement).innerText ?? "").slice(0, maxNodeTextChars);
      return "";
    };

    for (const element of elements) {
      if (nodes.length >= maxNodes) break;
      if (excluded.has(element.tagName)) continue;
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) continue;
      const id = nodes.length + 1;
      ids.set(element, id);
      let text = safeText(element);
      if (consumedText + text.length > maxTextChars) {
        text = text.slice(0, Math.max(0, maxTextChars - consumedText));
        textLimitReached = true;
      }
      consumedText += text.length;
      const parentId = element.parentElement ? ids.get(element.parentElement) ?? null : null;
      const classes = [...element.classList]
        .filter((token) => /^[\w-]{1,80}$/u.test(token))
        .slice(0, 8);
      const dataStatus = element.getAttribute("data-status")?.slice(0, 120) ?? null;
      nodes.push({
        id,
        parentId,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role")?.slice(0, 80) ?? null,
        classes,
        dataStatus,
        text,
        x: Math.round(rect.x),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      if (textLimitReached) break;
    }

    const rawVisibleText = document.body?.innerText ?? "";
    const visibleText = rawVisibleText.slice(0, maxTextChars);
    const nodeLimitReached = elements.length > nodes.length && nodes.length >= maxNodes;
    textLimitReached ||= rawVisibleText.length > maxTextChars;
    return {
      url: location.href,
      title: document.title,
      language: document.documentElement.lang || null,
      visibleText,
      nodes,
      truncated: nodeLimitReached || textLimitReached,
      nodeLimitReached,
      textLimitReached,
    };
  }, { maxNodes: MAX_NODES, maxTextChars: MAX_TEXT_CHARS, maxNodeTextChars: MAX_NODE_TEXT_CHARS });
}
