import { describe, expect, it } from "vitest";
import type { LocalDomNode } from "@application-checker/contracts";
import { isSelectableRuleNode, pickRuleNodeAtPoint } from "./rule-studio-selection";

function node(
  id: number,
  parentId: number | null,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
): LocalDomNode {
  return {
    id, parentId, text, x, y, width, height,
    tag: "div", role: null, classes: [], dataStatus: null,
  };
}

describe("rule studio screenshot selection", () => {
  it("chooses the smallest specific text node instead of a page container", () => {
    const nodes = [
      node(1, null, "首页 社会招聘 校园招聘 投递记录 收藏职位 账号设置", 0, 0, 1200, 800),
      node(2, 1, "[27校招 - 联合动力] 技术销售工程师 业务筛选-进行中", 250, 180, 720, 90),
      node(3, 2, "[27校招 - 联合动力] 技术销售工程师", 280, 200, 330, 24),
      node(4, 2, "业务筛选-进行中", 810, 200, 130, 24),
    ];
    expect(pickRuleNodeAtPoint(nodes, { x: 400, y: 212 }, 1200, 800)?.id).toBe(3);
    expect(pickRuleNodeAtPoint(nodes, { x: 850, y: 212 }, 1200, 800)?.id).toBe(4);
  });

  it("filters full-page and excessively long text containers", () => {
    expect(isSelectableRuleNode(node(1, null, "整页", 0, 0, 1200, 800), 1200, 800)).toBe(false);
    expect(isSelectableRuleNode(node(2, null, "x".repeat(241), 0, 0, 100, 20), 1200, 800)).toBe(false);
    expect(isSelectableRuleNode(node(3, null, "岗位标题", 20, 20, 150, 24), 1200, 800)).toBe(true);
  });
});
