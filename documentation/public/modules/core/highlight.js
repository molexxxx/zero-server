/**
 * core/highlight.js
 * Native syntax highlighter for the zero-http docs.
 *
 * Supported languages: javascript, html, css, json, bash
 *
 * API:
 *   ZHHighlight.highlight(codeElement)
 *   ZHHighlight.highlightAll(root)
 *   ZHHighlight.highlightString(source, lang)
 */

/* ------------------------------------------------------------------ */
/*  Token helpers                                                      */
/* ------------------------------------------------------------------ */

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls, text) {
  return '<span class="zh-' + cls + '">' + text + '</span>';
}

/* ------------------------------------------------------------------ */
/*  Language grammars  (order matters — first match wins)              */
/* ------------------------------------------------------------------ */

const JS_RULES = [
  ['tpl',       /`(?:[^`\\$]|\\[\s\S]|\$(?!\{)|\$\{(?:[^{}]|\{[^}]*\})*\})*`/],
  ['str',       /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  ['cmt',       /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
  ['rgx',       /\/(?!\*)(?:[^/\\[\n]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/],
  ['deco',      /@[a-zA-Z][\w.-]*/],
  ['self',      /\b(?:this|super)\b/],
  ['kw',        /\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|switch|throw|try|typeof|var|void|while|with|yield)\b/],
  ['val',       /\b(?:true|false|null|undefined|NaN|Infinity)\b/],
  ['num',       /\b(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d[\d_]*)?n?)\b/],
  ['builtin',   /\b(?:console|document|window|Math|JSON|Object|Array|String|Number|Boolean|RegExp|Date|Map|Set|WeakMap|WeakSet|Promise|Symbol|Error|TypeError|RangeError|SyntaxError|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|fetch|Request|Response|URL|URLSearchParams|FormData|Headers|AbortController|navigator|localStorage|sessionStorage|performance|requestAnimationFrame|cancelAnimationFrame|MutationObserver|IntersectionObserver|ResizeObserver|HTMLElement|Event|CustomEvent|Node|Element|NodeList|Proxy|Reflect|globalThis|queueMicrotask|structuredClone|crypto|atob|btoa|Buffer|process|require|module|exports|__dirname|__filename)\b/],
  ['attr',      /\b[a-zA-Z_$]\w*\b(?=\s*:(?!:))/],
  ['fn',        /\b[a-zA-Z_$]\w*(?=\s*\()/],
  ['fn',        /\.([a-zA-Z_$]\w*)(?=\s*\()/],
  ['prop',      /\.([a-zA-Z_$]\w*)\b/],
  ['cls',       /\b[A-Z][a-zA-Z0-9_]*\b/],
  ['punc',      /[{}()[\];,]|=>|\.{3}|\?\.|[+\-*/%=!<>&|^~?:]+/],
];

const HTML_RULES = [
  ['cmt',       /<!--[\s\S]*?-->/],
  ['kw',        /<!DOCTYPE[^>]*>/i],
  ['tag',       /<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/],
  ['ent',       /&[a-zA-Z0-9#]+;/],
];

const CSS_RULES = [
  ['cmt',       /\/\*[\s\S]*?\*\//],
  ['str',       /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/],
  ['kw',        /@[a-zA-Z][\w-]*/],
  ['num',       /#(?:[0-9a-fA-F]{3,4}){1,2}\b/],
  ['num',       /(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|s|ms|deg|rad|turn|fr|dpi|dpcm|dppx)?\b/],
  ['val',       /!important\b/],
  ['prop',      /[\w-]+(?=\s*:)/],
  ['deco',      /:{1,2}[a-zA-Z][\w-]*/],
  ['cls',       /[.#][\w-]+/],
  ['fn',        /[\w-]+(?=\()/],
  ['punc',      /[{}();:,>~+[\]=*^$|]/],
];

const JSON_RULES = [
  ['attr',      /"(?:[^"\\]|\\.)*"(?=\s*:)/],
  ['str',       /"(?:[^"\\]|\\.)*"/],
  ['num',       /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/],
  ['val',       /\b(?:true|false|null)\b/],
  ['punc',      /[{}[\]:,]/],
];

const BASH_RULES = [
  ['cmt',       /#[^\n]*/],
  ['str',       /"(?:[^"\\]|\\.)*"|'[^']*'/],
  ['deco',      /\$\{[^}]+\}|\$[A-Za-z_]\w*/],
  ['flag',      /\s--?[\w-]+/],
  ['fn',        /\b(?:npm|npx|node|git|cd|mkdir|cp|mv|rm|echo|cat|sudo|chmod|chown|curl|wget|ls|pwd|export|source|exit|vitest|jest)\b/],
  ['punc',      /[|><&;()]/],
  ['num',       /\b\d+\b/],
];

const GRAMMARS = {
  javascript: JS_RULES,
  js:         JS_RULES,
  html:       HTML_RULES,
  css:        CSS_RULES,
  json:       JSON_RULES,
  bash:       BASH_RULES,
  shell:      BASH_RULES,
};

/* ------------------------------------------------------------------ */
/*  HTML attribute parser                                              */
/* ------------------------------------------------------------------ */

function tokeniseHTMLTag(raw) {
  let result = '';
  let i = 0;
  const src = raw;
  const len = src.length;

  const tagOpen = /^(<\/?)([a-zA-Z][\w-]*)/;
  const m = src.match(tagOpen);
  if (m) {
    result += span('punc', esc(m[1])) + span('tag-name', esc(m[2]));
    i = m[0].length;
  }

  const attrRe = /\s+([:@]?[a-zA-Z][\w.:@-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  const closingRe = /\s*(\/?)\s*>$/;
  const closeMatch = src.match(closingRe);
  const attrsStr = closeMatch ? src.slice(i, src.length - closeMatch[0].length) : src.slice(i);

  let am;
  attrRe.lastIndex = 0;
  while ((am = attrRe.exec(attrsStr)) !== null) {
    const attrName = am[1];
    const attrVal = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
    const quote = am[2] !== undefined ? '"' : am[3] !== undefined ? "'" : '';

    result += ' ' + span('attr', esc(attrName));
    if (attrVal !== undefined) {
      result += span('punc', '=');
      if (quote) result += span('punc', quote);
      result += span('str', esc(attrVal));
      if (quote) result += span('punc', quote);
    }
  }

  if (closeMatch) {
    result += span('punc', esc(closeMatch[0].trim()));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Template literal handler                                           */
/* ------------------------------------------------------------------ */

function preprocess(source) {
  return source
    .replace(/\\\$/g, '$')
    .replace(/\\\{/g, '{')
    .replace(/\\`/g, '`');
}

function bodyLooksLikeHTML(body) {
  return /<[a-zA-Z][\w-]*[\s>\/]/.test(body);
}

function findTemplateLiteralEnd(source, pos) {
  let i = pos + 1;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      let depth = 1; i += 2;
      while (i < len && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        if (depth > 0) i++; else { i++; break; }
      }
      continue;
    }
    i++;
  }
  return len;
}

function tokeniseSimpleTemplate(body) {
  let result = '';
  let pos = 0;
  const len = body.length;
  while (pos < len) {
    if (body[pos] === '$' && body[pos + 1] === '{') {
      let depth = 1, j = pos + 2;
      while (j < len && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        if (depth > 0) j++; else break;
      }
      result += span('punc', esc('${'));
      result += tokenise(body.slice(pos + 2, j), 'javascript');
      result += span('punc', esc('}'));
      pos = j + 1;
    } else {
      const nextInterp = body.indexOf('${', pos);
      const seg = nextInterp === -1 ? body.slice(pos) : body.slice(pos, nextInterp);
      result += span('tpl', esc(seg));
      pos += seg.length;
    }
  }
  return result;
}

function tokeniseTemplateLiteral(body) {
  const interps = [];
  let processed = '';
  let pos = 0;
  const len = body.length;

  while (pos < len) {
    if (body[pos] === '$' && body[pos + 1] === '{') {
      let depth = 1, j = pos + 2;
      while (j < len && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        if (depth > 0) j++; else break;
      }
      const marker = '\x00ZH' + interps.length + '\x00';
      interps.push(body.slice(pos + 2, j));
      processed += marker;
      pos = j + 1;
    } else {
      processed += body[pos];
      pos++;
    }
  }

  let html = tokeniseHTML(processed);

  for (let k = 0; k < interps.length; k++) {
    const mk = '\x00ZH' + k + '\x00';
    const highlighted = span('punc', esc('${')) +
                      tokenise(interps[k], 'javascript') +
                      span('punc', esc('}'));
    html = html.replace(mk, highlighted);
  }
  return html;
}

/* ------------------------------------------------------------------ */
/*  Main tokeniser                                                     */
/* ------------------------------------------------------------------ */

function tokenise(source, lang) {
  const rules = GRAMMARS[lang];
  if (!rules) return esc(source);

  if (lang === 'html') return tokeniseHTML(source);

  if (lang === 'javascript' || lang === 'js') {
    source = preprocess(source);
  }

  const compiled = rules.map(function (r) {
    return [r[0], new RegExp(r[1].source, 'g')];
  });

  let result = '';
  let pos = 0;
  const len = source.length;

  while (pos < len) {
    if ((lang === 'javascript' || lang === 'js') && source[pos] === '`') {
      const tplEnd = findTemplateLiteralEnd(source, pos);
      const fullTpl = source.slice(pos, tplEnd);
      const tplBody = fullTpl.slice(1, -1);

      if (bodyLooksLikeHTML(tplBody)) {
        result += span('punc', '`');
        result += tokeniseTemplateLiteral(tplBody);
        result += span('punc', '`');
      } else {
        result += span('punc', '`');
        result += tokeniseSimpleTemplate(tplBody);
        result += span('punc', '`');
      }
      pos = tplEnd;
      continue;
    }

    let earliest = null;
    let earliestIdx = len;
    let earliestRule = null;

    for (let ri = 0; ri < compiled.length; ri++) {
      const re = compiled[ri][1];
      re.lastIndex = pos;
      const m = re.exec(source);
      if (m && m.index < earliestIdx) {
        earliest = m;
        earliestIdx = m.index;
        earliestRule = compiled[ri][0];
        if (earliestIdx === pos) break;
      }
    }

    if (!earliest || earliestIdx >= len) {
      result += esc(source.slice(pos));
      break;
    }

    const nextBacktick = source.indexOf('`', pos);
    if ((lang === 'javascript' || lang === 'js') && nextBacktick !== -1 && nextBacktick < earliestIdx) {
      if (nextBacktick > pos) result += esc(source.slice(pos, nextBacktick));
      pos = nextBacktick;
      continue;
    }

    if (earliestIdx > pos) {
      result += esc(source.slice(pos, earliestIdx));
    }

    if (earliestRule === 'tpl') {
      pos = earliestIdx;
      continue;
    }

    if ((earliestRule === 'prop' || earliestRule === 'fn') && earliest[1]) {
      result += span('punc', '.') + span(earliestRule, esc(earliest[1]));
    } else {
      result += span(earliestRule, esc(earliest[0]));
    }
    pos = earliestIdx + earliest[0].length;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  HTML tokeniser (handles nested <script>, <style>)                 */
/* ------------------------------------------------------------------ */

function tokeniseHTML(source) {
  let result = '';
  let pos = 0;
  const len = source.length;

  while (pos < len) {
    if (source.slice(pos, pos + 4) === '<!--') {
      const end = source.indexOf('-->', pos + 4);
      const cmtEnd = end === -1 ? len : end + 3;
      result += span('cmt', esc(source.slice(pos, cmtEnd)));
      pos = cmtEnd;
      continue;
    }

    if (source.slice(pos, pos + 9).toUpperCase() === '<!DOCTYPE') {
      const dtEnd2 = source.indexOf('>', pos);
      const dtEnd = dtEnd2 === -1 ? len : dtEnd2 + 1;
      result += span('kw', esc(source.slice(pos, dtEnd)));
      pos = dtEnd;
      continue;
    }

    const scriptOpen = /^<script\b([^>]*)>/i;
    const sm = source.slice(pos).match(scriptOpen);
    if (sm) {
      result += tokeniseHTMLTag(sm[0]);
      pos += sm[0].length;
      let closeIdx = source.toLowerCase().indexOf('</script>', pos);
      if (closeIdx === -1) closeIdx = len;
      const scriptBody = source.slice(pos, closeIdx);
      if (scriptBody) result += tokenise(scriptBody, 'javascript');
      if (closeIdx < len) { result += tokeniseHTMLTag('</script>'); pos = closeIdx + 9; }
      else pos = len;
      continue;
    }

    const styleOpen = /^<style\b([^>]*)>/i;
    const stm = source.slice(pos).match(styleOpen);
    if (stm) {
      result += tokeniseHTMLTag(stm[0]);
      pos += stm[0].length;
      let closeIdx2 = source.toLowerCase().indexOf('</style>', pos);
      if (closeIdx2 === -1) closeIdx2 = len;
      const styleBody = source.slice(pos, closeIdx2);
      if (styleBody) result += tokenise(styleBody, 'css');
      if (closeIdx2 < len) { result += tokeniseHTMLTag('</style>'); pos = closeIdx2 + 8; }
      else pos = len;
      continue;
    }

    if (source[pos] === '<' && (source[pos + 1] === '/' || /[a-zA-Z]/.test(source[pos + 1] || ''))) {
      let tagEnd = pos + 1;
      let inStr = false, strCh = '';
      while (tagEnd < len) {
        const ch = source[tagEnd];
        if (inStr) { if (ch === strCh) inStr = false; }
        else if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
        else if (ch === '>') { tagEnd++; break; }
        tagEnd++;
      }
      result += tokeniseHTMLTag(source.slice(pos, tagEnd));
      pos = tagEnd;
      continue;
    }

    if (source[pos] === '&') {
      const entEnd = source.indexOf(';', pos);
      if (entEnd !== -1 && entEnd - pos < 12) {
        result += span('ent', esc(source.slice(pos, entEnd + 1)));
        pos = entEnd + 1;
        continue;
      }
    }

    let nextSpecial = pos + 1;
    while (nextSpecial < len && source[nextSpecial] !== '<' && source[nextSpecial] !== '&') nextSpecial++;
    result += esc(source.slice(pos, nextSpecial));
    pos = nextSpecial;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Copy-to-clipboard button                                           */
/* ------------------------------------------------------------------ */

function addCopyButton(preEl) {
  if (preEl.parentNode && preEl.parentNode.classList && preEl.parentNode.classList.contains('zh-code-wrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'zh-code-wrap';
  preEl.parentNode.insertBefore(wrap, preEl);
  wrap.appendChild(preEl);

  const btn = document.createElement('button');
  btn.className = 'zh-copy-btn';
  btn.setAttribute('aria-label', 'Copy code');
  btn.textContent = 'Copy';
  btn.addEventListener('click', function () {
    const code = preEl.querySelector('code');
    if (!code) return;
    const text = code.textContent || code.innerText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied!';
        btn.classList.add('zh-copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('zh-copied'); }, 2000);
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { }
      document.body.removeChild(ta);
      btn.textContent = 'Copied!';
      btn.classList.add('zh-copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('zh-copied'); }, 2000);
    }
  });
  wrap.appendChild(btn);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export const ZHHighlight = {
  highlight(codeEl) {
    if (!codeEl || codeEl._zhHighlighted) return;
    const cls = codeEl.className || '';
    const langMatch = cls.match(/\blanguage-(\w+)/);
    const lang = langMatch ? langMatch[1] : 'javascript';
    const raw = codeEl.textContent || '';
    codeEl.innerHTML = tokenise(raw, lang);
    codeEl._zhHighlighted = true;
    codeEl.classList.add('zh-highlighted');
    const pre = codeEl.closest('pre');
    if (pre) addCopyButton(pre);
  },

  highlightAll(root) {
    root = root || document;
    const blocks = root.querySelectorAll('pre code[class*="language-"]:not(.zh-highlighted)');
    for (let i = 0; i < blocks.length; i++) {
      ZHHighlight.highlight(blocks[i]);
    }
  },

  highlightString(source, lang) {
    return tokenise(source, lang || 'javascript');
  }
};
