const keywordTokens = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "do", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "import",
  "in", "instanceof", "let", "new", "null", "of", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "yield",
]);

const applicationTokens = new Set(["application", "applications", "helpers"]);
const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:\d+(?:\.\d+)?|[A-Za-z_$][\w$]*)\b/g;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function tokenClass(token: string): string | null {
  if (token.startsWith("//") || token.startsWith("/*")) return "syntax-comment";
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) return "syntax-string";
  if (/^\d/.test(token)) return "syntax-number";
  if (keywordTokens.has(token)) return "syntax-keyword";
  if (applicationTokens.has(token)) return "syntax-api";
  return null;
}

export function highlightJavaScript(source: string): string {
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index ?? cursor;
    output += escapeHtml(source.slice(cursor, index));
    const token = match[0];
    const className = tokenClass(token);
    output += className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token);
    cursor = index + token.length;
  }
  return `${output}${escapeHtml(source.slice(cursor))}\n`;
}
