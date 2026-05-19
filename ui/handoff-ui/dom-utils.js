(function () {
const $ = (selector) => document.querySelector(selector);

function hasSnapshotApi() {
  return /^https?:$/.test(window.location.protocol);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pad(n, size = 2) {
  return String(n).padStart(size, "0");
}

function fmtTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms == null) return "running";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${pad(sec % 60)}s`;
}

function elapsedSince(iso, fallbackMs = 0) {
  const liveMs = Date.now() - new Date(iso).getTime();
  return fmtDuration(Math.max(fallbackMs, liveMs));
}

function ago(iso) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortId(id) {
  if (!id) return "-";
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function kbdGuard(event) {
  return event.metaKey || event.ctrlKey || event.altKey || Boolean(event.target.closest("input,textarea,[contenteditable]"));
}

function renderMarkdown(value) {
  const markdown = String(value ?? "").replace(/\r\n/g, "\n");
  if (!window.marked) return `<p>${escapeHtml(markdown).replaceAll("\n", "<br>")}</p>`;
  const renderer = new window.marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.code = ({ text, lang }) => {
    const language = window.hljs && window.hljs.getLanguage(lang) ? lang : "plaintext";
    const highlighted = window.hljs
      ? window.hljs.highlight(text, { language }).value
      : escapeHtml(text);
    return `<pre class="code-block"><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`;
  };
  return window.marked.parse(markdown, {
    gfm: true,
    breaks: true,
    renderer,
  });
}

function renderCodeBlock(value, languageHint = "") {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  const hinted = String(languageHint ?? "").toLowerCase();
  const language = window.hljs && window.hljs.getLanguage(hinted)
    ? hinted
    : inferCodeLanguage(text);
  const highlighted = window.hljs
    ? window.hljs.highlight(text, { language }).value
    : escapeHtml(text);
  return `<pre class="code-block tool-code"><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre>`;
}

function inferCodeLanguage(text) {
  const trimmed = text.trim();
  if (!trimmed) return "plaintext";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  }
  if (/^(---|\+\+\+|@@|\+|-)/m.test(trimmed)) return "diff";
  if (/^(\$ |>|bun |npm |pnpm |yarn |git |cd |ls |cat |sed |rg |grep )/m.test(trimmed)) return "bash";
  if (/^\s*(import|export|const|let|type|interface|function|class)\b/m.test(trimmed)) return "typescript";
  if (/^\s*(def|class|from|import)\b/m.test(trimmed)) return "python";
  return "plaintext";
}

window.RelayUiUtils = { $, hasSnapshotApi, escapeHtml, renderMarkdown, renderCodeBlock, pad, fmtTime, fmtDuration, elapsedSince, ago, shortId, kbdGuard };
})();
