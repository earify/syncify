// Shared-note HTML rendering for /share/:id

interface PropertyEntry {
  key: string;
  value: unknown;
}

const AMP = String.fromCharCode(38); // "&" — written via char code so this file has no literal entities

export function escHtml(s: string): string {
  let out = s.split(AMP).join(AMP + "amp;");
  out = out.split("<").join(AMP + "lt;");
  out = out.split(">").join(AMP + "gt;");
  out = out.split('"').join(AMP + "quot;");
  return out;
}

function inlineMd(s: string): string {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
  out = out.replace(/==(.+?)==/g, (_m, c) => `<mark class='hl'>${escHtml(c)}</mark>`);
  out = out.replace(/(^|\s)\*([^*]+)\*/g, (_m, pre, c) => `${pre}<em>${c}</em>`);
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, text, url) => `<a href="${escHtml(url)}" rel="noopener noreferrer">${escHtml(text)}</a>`,
  );
  return out;
}

function splitFrontmatter(markdown: string): { block: string | null; body: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return { block: null, body: markdown };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { block: null, body: markdown };
  return { block: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function isDateLike(v: unknown): boolean {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(v)
  );
}

function parseInlineArray(text: string): unknown[] {
  const body = text.slice(1, -1).trim();
  if (body === "") return [];
  const parsed: unknown[] = [];
  let current = "";
  let quote = "";
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      const item = current.trim();
      if (item !== "") parsed.push(parseYamlScalar(item));
      current = "";
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail !== "") parsed.push(parseYamlScalar(tail));
  return parsed;
}

function parseYamlScalar(text: string): unknown {
  const v = text.trim();
  if (v === "" || v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return parseInlineArray(v);
  return v;
}

function parseFrontmatter(block: string | null): PropertyEntry[] {
  if (!block) return [];
  const entries: PropertyEntry[] = [];
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;
  let currentScalar: unknown = undefined;
  let nested: string[] = [];

  const flush = () => {
    if (currentKey === null) return;
    if (nested.length > 0 && currentList === null && currentScalar === undefined) {
      currentScalar = nested.join("; ");
    }
    const value = currentList !== null ? currentList : currentScalar;
    entries.push({ key: currentKey, value: value === undefined ? null : value });
    currentKey = null;
    currentList = null;
    currentScalar = undefined;
    nested = [];
  };

  for (const raw of block.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indented = /^\s/.test(raw);
    const match = trimmed.match(/^([\p{L}\p{N}\s_.-]+?):\s*(.*)$/u);
    if (!indented && match) {
      flush();
      currentKey = match[1];
      const rest = match[2].trim();
      currentScalar = rest === "" ? undefined : parseYamlScalar(rest);
      currentList = null;
      continue;
    }
    if (currentKey && (trimmed.startsWith("- ") || trimmed === "-")) {
      const item = trimmed.replace(/^-\s*/, "");
      if (currentList === null) currentList = [];
      currentList.push(parseYamlScalar(item));
      continue;
    }
    if (currentKey && indented) nested.push(trimmed);
  }
  flush();
  return entries;
}

function frontmatterTitle(entries: PropertyEntry[]): string | null {
  const entry = entries.find((e) => e.key.toLowerCase() === "title");
  return typeof entry?.value === "string" && entry.value.trim() ? entry.value.trim() : null;
}

function fileNameTitle(filePath: string): string {
  const name = filePath.split("/").pop() || filePath;
  return name.replace(/\.md$/i, "").replace(/\.markdown$/i, "");
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function renderPropValue(value: unknown, key: string): string {
  if (value === null || value === undefined || value === "") return '<span class="prop-empty">Empty</span>';
  if (typeof value === "boolean") {
    return (
      '<label class="prop-checkbox"><input type="checkbox" disabled' +
      (value ? " checked" : "") +
      "><span>" +
      (value ? "true" : "false") +
      "</span></label>"
    );
  }
  if (typeof value === "number") return `<span class="prop-number">${escHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="prop-empty">Empty</span>';
    const isTags = key.toLowerCase() === "tags";
    return (
      '<span class="prop-chips">' +
      value
        .map((v) => {
          const raw = v === null || v === undefined ? "" : String(v);
          return `<span class="${isTags ? "tag-chip" : "chip"}">${isTags ? "#" + escHtml(raw) : escHtml(raw)}</span>`;
        })
        .join("") +
      "</span>"
    );
  }
  const v = String(value);
  if (isDateLike(v)) return `<time class="prop-date">${escHtml(v)}</time>`;
  return `<span class="prop-text">${escHtml(v)}</span>`;
}

function renderProperties(entries: PropertyEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map(
      (entry) =>
        `<div class="property"><dt class="prop-key">${escHtml(entry.key)}</dt><dd class="prop-val">${renderPropValue(entry.value, entry.key)}</dd></div>`,
    )
    .join("");
  return `<section class="properties" aria-label="Properties"><h2 class="props-title">Properties</h2><dl class="props-list">${rows}</dl></section>`;
}

function renderSharedMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let para: string[] = [];
  let inUl = false;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(" "))}</p>`);
    para = [];
  };
  const closeUl = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      flushPara();
      closeUl();
      continue;
    }
    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) {
      flushPara();
      closeUl();
      out.push("<hr>");
      continue;
    }
    if (raw.startsWith("```")) {
      if (!inCode) {
        flushPara();
        closeUl();
        inCode = true;
        out.push("<pre><code>");
      } else {
        inCode = false;
        out.push("</code></pre>");
      }
      continue;
    }
    if (inCode) {
      out.push(escHtml(raw));
      continue;
    }
    const m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flushPara();
      closeUl();
      out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`);
      continue;
    }
    const q = raw.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      closeUl();
      out.push(`<blockquote>${inlineMd(q[1])}</blockquote>`);
      continue;
    }
    const li = raw.match(/^[-*+]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    const numli = raw.match(/^\d+\.\s+(.*)$/);
    if (numli) {
      flushPara();
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inlineMd(numli[1])}</li>`);
      continue;
    }
    if (/^!\[\[.+?\]\]/.test(raw)) {
      const att = raw.match(/^!\[\[(.+?)\]\]/);
      const name = att ? att[1] : "attachment";
      flushPara();
      closeUl();
      out.push(
        `<p><span class="attachment">${escHtml(name)} - attachment not included in shared view</span></p>`,
      );
      continue;
    }
    para.push(raw);
  }
  flushPara();
  closeUl();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

export function renderSharedPage(title: string, markdown: string): string {
  const safeTitle = escHtml(title);
  const split = splitFrontmatter(markdown);
  const entries = parseFrontmatter(split.block);
  const displayTitle = frontmatterTitle(entries) || fileNameTitle(title);
  const propsHtml = renderProperties(entries);
  const body = renderSharedMarkdown(split.body);
  const headingAsTitle = body.match(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/);
  const headingText = headingAsTitle ? stripHtmlTags(headingAsTitle[1]) : "";
  const showTitle = !headingAsTitle || normalizeTitle(headingText) !== normalizeTitle(displayTitle);
  const titleHtml = showTitle ? `<h1 class="note-title">${escHtml(displayTitle)}</h1>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${safeTitle} - shared note</title>
<style>
  * { box-sizing: border-box; }
  :root { color-scheme: dark; }
  body { margin:0; padding:clamp(18px, 4vw, 56px); background:
      radial-gradient(circle at top, #151926 0, #0f1115 42rem), #0f1115;
    color:#f2f4f8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size:19px; line-height:1.78; max-width:980px; margin-inline:auto; -webkit-font-smoothing:antialiased; }
  h1,h2,h3,h4,h5,h6 { line-height:1.2; font-weight:750; letter-spacing:-0.025em; margin:1.55em 0 .45em; color:#ffffff; scroll-margin-top:1em; }
  h1 { font-size:clamp(2rem, 3.4vw, 2.65rem); }
  h2 { font-size:clamp(1.55rem, 2.6vw, 1.95rem); padding-bottom:.28em; border-bottom:1px solid #272c36; }
  h3 { font-size:1.45rem; }
  h4 { font-size:1.2rem; color:#e8ecf2; }
  p { margin:1.05em 0; }
  a { color:#8eb4ff; text-decoration:none; border-bottom:1px solid rgba(142,180,255,.35); }
  a:hover { border-bottom-color:#8eb4ff; }
  strong { color:#ffffff; font-weight:700; }
  em { color:#e4e8f0; }
  ul, ol { margin:1em 0; padding-left:1.55em; }
  li { margin:.42em 0; }
  li::marker { color:#7c879a; }
  blockquote { margin:1.3em 0; padding:.95em 1.1em; color:#d5dbe6; background:rgba(124,146,255,.08); border:1px solid rgba(124,146,255,.16); border-left:4px solid #7f98ff; border-radius:10px; }
  blockquote p { margin:.35em 0; }
  pre { margin:1.25em 0; padding:18px; background:#161a22; border:1px solid #262b36; border-radius:11px; overflow:auto; font-size:.92em; line-height:1.65; }
  code { background:#1b202a; color:#f2f4f8; padding:.18em .42em; border-radius:6px; font-size:.88em; border:1px solid #313848; }
  pre code { background:transparent; border:0; padding:0; color:#edf0f7; }
  mark.hl { background:linear-gradient(180deg, rgba(249,226,175,.52), rgba(249,226,175,.3)); color:#fff; padding:0 .3em; border-radius:4px; box-shadow:0 0 0 .12rem rgba(249,226,175,.09); }
  img { max-width:100%; border-radius:10px; }
  hr { margin:2em 0; height:1px; border:0; background:linear-gradient(90deg, transparent, #3a4150 20%, #3a4150 80%, transparent); }
  table { width:100%; border-collapse:collapse; margin:1.25em 0; font-size:.94em; }
  th, td { padding:10px 12px; border:1px solid #303645; text-align:left; }
  th { background:#1b202a; font-weight:700; color:#ffffff; }
  .note-title { margin:0 0 .28em; font-size:clamp(1.85rem, 3.2vw, 2.45rem); font-weight:780; letter-spacing:-0.03em; line-height:1.08; color:#ffffff; }
  .meta { color:#a7b0be; font-size:.9rem; margin-bottom:1em; }
  .md { word-break:break-word; }
  .properties { margin:0 0 1.5em; padding:11px 14px 4px; background:rgba(255,255,255,.035); border:1px solid #262b36; border-radius:12px; }
  .props-title { margin:0 0 .5em; font-size:.8rem; font-weight:750; letter-spacing:.04em; text-transform:uppercase; color:#8b95a7; }
  .props-list { display:grid; gap:.12rem; margin:0; padding:0; }
  .property { display:grid; grid-template-columns:minmax(120px,.28fr) 1fr; gap:.65rem; align-items:start; padding:.42rem 0; border-top:1px solid rgba(255,255,255,.045); }
  .property:first-child { border-top:0; padding-top:.1rem; }
  .prop-key { color:#b9c3d3; font-size:.84rem; font-weight:650; line-height:1.4; word-break:break-word; padding-top:.08rem; }
  .prop-val { font-size:.94rem; line-height:1.55; word-break:break-word; white-space:pre-wrap; }
  .prop-empty { color:#69717f; font-style:italic; }
  .prop-number { font-variant-numeric:tabular-nums; }
  .prop-checkbox { display:inline-flex; align-items:center; gap:.35rem; }
  .prop-date { color:#d6deea; }
  .chip, .tag-chip { display:inline-block; margin:0 .3rem .2rem 0; padding:.12em .58em; border-radius:999px; font-size:.86rem; vertical-align:baseline; }
  .chip { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.08); color:#eaf0f8; }
  .tag-chip { background:rgba(112,163,230,.14); border:1px solid rgba(112,163,230,.26); color:#b9d8ff; }
  .attachment { display:inline-block; padding:.32em .72em; margin:.35em 0; color:#f6e7b8; background:rgba(249,226,175,.11); border:1px dashed rgba(249,226,175,.38); border-radius:999px; font-size:.92em; }
  @media (max-width: 640px) { body { font-size:17px; padding:16px; } h1 { font-size:1.9rem; } h2 { font-size:1.45rem; } }
</style>
</head>
<body>
<div class="md">
${titleHtml}
<div class="meta">Shared note: ${safeTitle}</div>
${propsHtml}
${body}
</div>
</body>
</html>`;
}
