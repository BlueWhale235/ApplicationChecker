import type { LocalDomNode } from "@application-checker/contracts";

export interface ScreenshotPoint {
  x: number;
  y: number;
}

export function isSelectableRuleNode(
  node: LocalDomNode,
  screenshotWidth: number,
  screenshotHeight: number,
): boolean {
  const text = node.text.trim();
  if (!text || text.length > 240) return false;
  if (node.width < 2 || node.height < 2 || node.x < 0 || node.y < 0) return false;
  if (node.x >= screenshotWidth || node.y >= screenshotHeight) return false;
  const visibleWidth = Math.min(node.width, screenshotWidth - node.x);
  const visibleHeight = Math.min(node.height, screenshotHeight - node.y);
  const areaRatio = visibleWidth * visibleHeight / (screenshotWidth * screenshotHeight);
  return areaRatio <= 0.25;
}

function nodeDepth(node: LocalDomNode, byId: Map<number, LocalDomNode>): number {
  let depth = 0;
  let current = node;
  while (current.parentId !== null && depth < 20) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}

export function pickRuleNodeAtPoint(
  nodes: LocalDomNode[],
  point: ScreenshotPoint,
  screenshotWidth: number,
  screenshotHeight: number,
): LocalDomNode | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const candidates = nodes.filter((node) =>
    isSelectableRuleNode(node, screenshotWidth, screenshotHeight)
    && point.x >= node.x
    && point.x <= node.x + node.width
    && point.y >= node.y
    && point.y <= node.y + node.height);
  candidates.sort((left, right) => {
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return leftArea - rightArea
      || nodeDepth(right, byId) - nodeDepth(left, byId)
      || left.text.trim().length - right.text.trim().length;
  });
  return candidates[0] ?? null;
}
