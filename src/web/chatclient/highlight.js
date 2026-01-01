// A small, text-only tokenizer. Loaded on the first fenced block, with no grammar dependency.
const keywords = new Set(('as async await break case catch class const continue def default delete do elif else enum except export extends false finally fn for from function if import in instanceof interface lambda let new nil None null of pass print raise return self static struct super switch then this throw true try type typeof undefined var void while with yield and not or True False').split(' '));
export function tokenize(text, language = '') {
  const hashComments = /^(?:py|python|sh|bash|shell|ruby|rb|yaml|yml)$/i.test(language);
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*)|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
  const tokens = []; let last = 0, match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) tokens.push({text: text.slice(last, match.index)});
    const comment = match[2] && (!match[2].startsWith('#') || hashComments);
    const type = match[1] ? 'string' : comment ? 'comment' : match[3] ? 'number' : keywords.has(match[4]) ? 'keyword' : null;
    tokens.push({text: match[0], type}); last = pattern.lastIndex;
  }
  if (last < text.length) tokens.push({text: text.slice(last)});
  return tokens;
}
export function highlight(node, text, language) {
  node.replaceChildren(...tokenize(text, language).map(token => {
    if (!token.type) return document.createTextNode(token.text);
    const span = document.createElement('span'); span.className = 'token-' + token.type; span.textContent = token.text; return span;
  }));
}
