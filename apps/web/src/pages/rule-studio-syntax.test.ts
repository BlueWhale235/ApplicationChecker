import { describe, expect, it } from "vitest";
import { highlightJavaScript } from "./rule-studio-syntax";

describe("rule studio JavaScript highlighting", () => {
  it("colors JavaScript tokens and escapes user-authored HTML", () => {
    const highlighted = highlightJavaScript('const value = helpers.text("<status>"); // read');
    expect(highlighted).toContain('class="syntax-keyword">const</span>');
    expect(highlighted).toContain('class="syntax-api">helpers</span>');
    expect(highlighted).toContain('class="syntax-string">"&lt;status&gt;"</span>');
    expect(highlighted).toContain('class="syntax-comment">// read</span>');
    expect(highlighted).not.toContain("<status>");
  });
});
