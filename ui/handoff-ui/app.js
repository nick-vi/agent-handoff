(function () {
const { $, hasSnapshotApi, escapeHtml, renderMarkdown, renderCodeBlock, pad, fmtTime, fmtDuration, elapsedSince, ago, shortId, kbdGuard } = window.RelayUiUtils;
let data = {
  workspace: {
    root: "",
    basename: "agent-handoff",
    hash: "",
    schemaVersion: 1,
    pointer: null,
    stateDir: "",
    workspaces: [],
  },
  running: [],
  topics: [],
  transcripts: {},
};
let productionMode = false;
const PROJECT_ALL = "all";

const state = {
  lifecycle: new Set(["active", "stale"]),
  query: "",
  selectedProject: localStorage.getItem("handoff:selectedProject") || PROJECT_ALL,
  selectedTopic: "",
  selectedRound: null,
  isRefreshing: false,
  lastUpdatedAt: null,
  apiError: null,
};

const agentLabel = { claude: "claude", codex: "codex", cursor: "cursor" };

function topicKey(topic) {
  return topic?.key ?? (topic?.workspace?.dirName ? `${topic.workspace.dirName}/${topic.slug}` : topic?.slug);
}

function workspaceLabel(workspace) {
  if (!workspace) return "";
  return `${workspace.basename} (${String(workspace.hash ?? "").slice(0, 4)})`;
}

function workspaces() {
  return data.workspace.workspaces?.length
    ? data.workspace.workspaces
    : [{
        root: data.workspace.root,
        basename: data.workspace.basename,
        hash: data.workspace.hash,
        dirName: data.workspace.dirName,
      }];
}

function selectedProjectExists() {
  return state.selectedProject === PROJECT_ALL
    || workspaces().some((workspace) => workspace.dirName === state.selectedProject);
}

function topicMatchesProject(topic) {
  if (state.selectedProject === PROJECT_ALL) return true;
  return (topic.workspace?.dirName ?? data.workspace.dirName) === state.selectedProject;
}

function selectedTopic() {
  return data.topics.find((topic) => topicMatchesProject(topic) && topicKey(topic) === state.selectedTopic)
    ?? data.topics.find((topic) => topicMatchesProject(topic) && topic.slug === state.selectedTopic)
    ?? filteredTopics()[0]
    ?? data.topics.find(topicMatchesProject)
    ?? null;
}

function selectedRound(topic = selectedTopic()) {
  return topic?.rounds.find((round) => round.index === state.selectedRound) ?? topic?.rounds[0] ?? null;
}

function handoffSender(round) {
  return round?.fromAgent
    ? agentLabel[round.fromAgent] ?? round.fromAgent
    : "external";
}

function handoffRoute(round) {
  const to = agentLabel[round?.agent] ?? round?.agent ?? "agent";
  return `${handoffSender(round)} -> ${to}`;
}

function bestDefaultTopic() {
  const visible = data.topics.filter((topic) => topicMatchesProject(topic) && state.lifecycle.has(topic.lifecycle));
  const byRecent = [...visible].sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  const withTranscript = byRecent.find((topic) => topic.rounds.some((round) => hasTranscript(round)));
  if (withTranscript) return withTranscript;
  return byRecent[0] ?? null;
}

function bestDefaultRound(topic) {
  if (!topic) return null;
  const transcriptRound = [...topic.rounds].reverse().find((round) => hasTranscript(round));
  return transcriptRound?.index ?? visibleRounds(topic)[0]?.index ?? sortedRounds(topic)[0]?.index ?? null;
}

function sortedRounds(topic = selectedTopic()) {
  if (!topic) return [];
  return [...topic.rounds].sort((a, b) => a.index - b.index);
}

function visibleRounds(topic = selectedTopic()) {
  const query = state.query.trim().toLowerCase();
  const rounds = sortedRounds(topic);
  if (!query) return rounds;
  return rounds.filter((round) => {
    const blob = [
      round.agent,
      round.mode,
      round.verdict,
      round.sessionId ?? "",
      round.promptPreview,
      round.resultPreview,
    ].join(" ").toLowerCase();
    return blob.includes(query);
  });
}

function selectFirstVisibleRound(topic = selectedTopic()) {
  state.selectedRound = visibleRounds(topic)[0]?.index ?? sortedRounds(topic)[0]?.index ?? null;
}

function highlight(value) {
  const text = escapeHtml(value ?? "");
  const query = state.query.trim();
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(escapeHtml(query).toLowerCase());
  if (idx < 0) return text;
  return `${text.slice(0, idx)}<mark>${text.slice(idx, idx + query.length)}</mark>${text.slice(idx + query.length)}`;
}

function hasTranscript(round) {
  return Boolean(round?.sessionId && data.transcripts[`${round.agent}:${round.sessionId}`]);
}

function transcriptForRound(round) {
  if (!round?.sessionId) return null;
  return data.transcripts[`${round.agent}:${round.sessionId}`] ?? null;
}

function visibleTranscriptTurns(transcript) {
  return (transcript?.turns ?? []).filter((turn) => {
    const normalized = normalizeTurn(turn);
    if (normalized.kind === "system" || normalized.kind === "thinking") return false;
    return true;
  });
}

function turnsForRound(topic, round, transcript) {
  const allTurns = visibleTranscriptTurns(transcript);
  if (!round?.startedAt) return allTurns;
  const end = new Date(round.startedAt).getTime();
  const previous = topic?.rounds
    .filter((candidate) =>
      candidate.index < round.index &&
      candidate.agent === round.agent &&
      candidate.sessionId === round.sessionId &&
      candidate.startedAt
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  const start = round.durationMs != null
    ? end - round.durationMs
    : previous?.startedAt
      ? new Date(previous.startedAt).getTime()
      : Number.NEGATIVE_INFINITY;
  const turns = allTurns.filter((turn) => {
    if (!turn.ts) return false;
    const ts = new Date(turn.ts).getTime();
    return ts >= start && ts <= end;
  });
  return round.agent === "claude" ? withoutClaudeResumeScaffold(turns) : turns;
}

function withoutClaudeResumeScaffold(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i += 1) {
    const current = turns[i];
    const next = turns[i + 1];
    if (
      current?.role === "user" &&
      next?.role === "assistant" &&
      current.text.trim() === "Continue from where you left off." &&
      next.text.trim() === "No response requested."
    ) {
      i += 1;
      continue;
    }
    out.push(current);
  }
  return out;
}

function normalizeTurn(turn) {
  const text = String(turn?.text ?? "").trim();
  const name = String(turn?.toolName ?? turn?.name ?? "").trim();
  const tag = /^<([a-z_]+)(?::\s*([^>]+))?>$/i.exec(text);
  const toolWithBody = /^<tool:\s*([^>]+)>\s*([\s\S]*)$/i.exec(text);
  const resultWithBody = /^<tool_result>\s*([\s\S]*)$/i.exec(text);
  const tagKind = tag?.[1]?.toLowerCase() ?? "";
  const tagName = tag?.[2]?.trim() ?? "";
  if (toolWithBody) {
    const label = name || toolWithBody[1]?.trim() || "Tool";
    const body = toolWithBody[2]?.trim() ?? "";
    return {
      kind: "tool",
      label,
      title: label,
      text: body,
      markerOnly: body.length === 0,
    };
  }
  if (resultWithBody) {
    const body = resultWithBody[1]?.trim() ?? "";
    return {
      kind: "tool_result",
      label: "result",
      title: "Tool result",
      text: body,
      markerOnly: body.length === 0,
    };
  }
  if (turn.role === "tool" || tagKind === "tool") {
    return {
      kind: "tool",
      label: tagName || name || "Tool",
      title: tagName || name || "Tool call",
      text: tagKind === "tool" ? "" : text,
      markerOnly: tagKind === "tool",
    };
  }
  if (turn.role === "tool_result" || tagKind === "tool_result") {
    return { kind: "tool_result", label: "result", title: "Tool result", text: tagKind === "tool_result" ? "" : text, markerOnly: tagKind === "tool_result" };
  }
  if (tagKind === "thinking") {
    return { kind: "thinking", label: "thinking", title: "Thinking", text: "", markerOnly: true };
  }
  if (turn.role === "system" || turn.role === "developer") {
    return { kind: "system", label: "system", title: "System", text };
  }
  return {
    kind: turn.role === "assistant" ? "assistant" : turn.role === "user" ? "user" : "message",
    label: turn.role ?? "message",
    title: turn.role ?? "message",
    text,
  };
}

function groupTranscriptTurns(turns) {
  const items = [];
  const pendingById = new Map();
  const pendingLoose = [];
  for (const turn of turns) {
    const normalized = normalizeTurn(turn);
    if (normalized.kind === "tool") {
      const item = { kind: "tool_pair", call: turn, callNormalized: normalized, result: null, resultNormalized: null };
      items.push(item);
      if (turn.toolUseId) pendingById.set(turn.toolUseId, item);
      else pendingLoose.push(item);
      continue;
    }
    if (normalized.kind === "tool_result") {
      const item = (turn.toolUseId && pendingById.get(turn.toolUseId)) || pendingLoose.shift();
      if (item && !item.result) {
        item.result = turn;
        item.resultNormalized = normalized;
        if (turn.toolUseId) pendingById.delete(turn.toolUseId);
      } else {
        items.push({ kind: "turn", turn, normalized });
      }
      continue;
    }
    items.push({ kind: "turn", turn, normalized });
  }
  return items;
}

function transcriptState(round) {
  if (!round?.sessionId) {
    return {
      tone: "unknown",
      label: "no session id",
      detail: "The adapter did not return a durable pointer, so only handoff metadata is available.",
    };
  }
  if (!hasTranscript(round)) {
    return {
      tone: "blocked",
      label: "missing transcript",
      detail: "Handoff stored the session id, but the native transcript resolver cannot find the local file.",
    };
  }
  return {
    tone: "ok",
    label: "transcript resolved",
    detail: "Native chat content is available for this agent session.",
  };
}

function filteredTopics() {
  const query = state.query.trim().toLowerCase();
  return data.topics.filter((topic) => {
    if (!topicMatchesProject(topic)) return false;
    if (!state.lifecycle.has(topic.lifecycle)) return false;
    if (!query) return true;
    const blob = [
      topic.workspace?.basename ?? "",
      topic.workspace?.root ?? "",
      topic.slug,
      topic.summary ?? "",
      ...Object.values(topic.sessions).filter(Boolean),
    ].join(" ").toLowerCase();
    return blob.includes(query);
  });
}

function reconcileSelection() {
  if (!data.topics.some((topic) => topicMatchesProject(topic) && topicKey(topic) === state.selectedTopic)) {
    const pointed = data.workspace.pointer
      ? data.topics.find((topic) => topicMatchesProject(topic) && topic.slug === data.workspace.pointer)
      : null;
    state.selectedTopic = topicKey(pointed ?? bestDefaultTopic()) ?? "";
  }
  const topic = selectedTopic();
  if (!topic) return;
  if (!topic.rounds.some((round) => round.index === state.selectedRound)) {
    state.selectedRound = bestDefaultRound(topic);
  }
}

async function loadProductionData() {
  if (!hasSnapshotApi()) {
    state.apiError = "Open this inspector through `handoff ui` so it can read /api/snapshot.";
    return false;
  }
  try {
    const selected = productionMode && state.selectedTopic
      ? `&topic=${encodeURIComponent(state.selectedTopic)}`
      : "";
    const response = await fetch(`/api/snapshot?scope=all${selected}`, { cache: "no-store" });
    if (!response.ok) {
      state.apiError = `/api/snapshot returned HTTP ${response.status}.`;
      return false;
    }
    data = await response.json();
    productionMode = true;
    if (!selectedProjectExists()) state.selectedProject = PROJECT_ALL;
    state.lastUpdatedAt = new Date();
    state.apiError = null;
    reconcileSelection();
    return true;
  } catch (error) {
    state.apiError = error instanceof Error ? error.message : "Could not load /api/snapshot.";
    return false;
  }
}

function capturePaneState() {
  return {
    topicsScroll: $("#topics")?.scrollTop ?? 0,
    timelineScroll: $("#timeline")?.scrollTop ?? 0,
    inspectorScroll: $("#inspector")?.scrollTop ?? 0,
  };
}

function restorePaneState(snapshot) {
  if (!snapshot) return;
  const scrollTargets = [
    ["#topics", snapshot.topicsScroll],
    ["#timeline", snapshot.timelineScroll],
    ["#inspector", snapshot.inspectorScroll],
  ];
  for (const [selector, scrollTop] of scrollTargets) {
    const node = $(selector);
    if (node) node.scrollTop = scrollTop;
  }
}

function updateLiveControls() {
  const label = $("#live-label");
  if (label) {
    if (document.hidden) label.textContent = "paused";
    else if (state.apiError) label.textContent = "offline";
    else if (!productionMode) label.textContent = "loading";
    else if (state.isRefreshing) label.textContent = "refreshing";
    else label.textContent = state.lastUpdatedAt ? `updated ${fmtTime(state.lastUpdatedAt.toISOString())}` : "live";
  }

}

async function refreshProductionData({ preserve = true, scrollSelected = false } = {}) {
  if (!hasSnapshotApi() || document.hidden || state.isRefreshing) return false;
  state.isRefreshing = true;
  updateLiveControls();
  const snapshot = preserve ? capturePaneState() : null;
  const loaded = await loadProductionData();
  state.isRefreshing = false;
  if (!loaded) {
    updateLiveControls();
    return false;
  }
  render({ scrollSelected });
  restorePaneState(snapshot);
  updateLiveControls();
  return true;
}

function render(options = {}) {
  reconcileSelection();
  renderWorkspaceSelect();
  const workspaceCount = workspaces().length;
  const release = data.workspace.releaseVersion
    ? `v${data.workspace.releaseVersion}${workspaceCount > 1 ? ` · ${workspaceCount} projects` : ""}`
    : workspaceCount > 1
      ? `${workspaceCount} projects`
      : "";
  $("#workspace-hash").textContent = release;
  updateLiveControls();
  renderTopics();
  renderTimeline();
  renderRelayTimeline();
  if (options.scrollSelected !== false) queueSelectedScroll();
}

function queueSelectedScroll() {
  requestAnimationFrame(syncSelectedVisibility);
}

function syncSelectedVisibility() {
  const topic = selectedTopic();
  const topicRow = [...document.querySelectorAll("[data-topic]")]
    .find((row) => row.dataset.topic === topicKey(topic));
  topicRow?.scrollIntoView({ block: "nearest" });

  const roundRow = [...document.querySelectorAll("[data-round]")]
    .find((row) => Number(row.dataset.round) === state.selectedRound);
  roundRow?.scrollIntoView({ block: "nearest" });
}

function refreshLiveText() {
  document.querySelectorAll('[data-live="topic-ago"]').forEach((node) => {
    node.textContent = `${ago(node.dataset.startedAt)}${node.dataset.running === "1" ? " run" : ""}`;
  });
  document.querySelectorAll('[data-live="round-duration"]').forEach((node) => {
    node.textContent = elapsedSince(node.dataset.startedAt);
  });
}

function renderTopics() {
  const topics = filteredTopics();
  $("#topic-count").textContent = String(topics.length);
  if (topics.length === 0) {
    const emptyTitle = state.apiError ? "Handoff UI is offline" : "No matching topics";
    const emptyDetail = state.apiError
      ? state.apiError
      : "Clear search or create one with handoff send --topic <slug>.";
    $("#topics").innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(emptyTitle)}</strong>
        <span>${escapeHtml(emptyDetail)}</span>
      </div>
    `;
    return;
  }
  if (state.selectedProject === PROJECT_ALL) {
    const groups = [...new Map(topics.map((topic) => [topic.workspace?.dirName ?? "unknown", topic.workspace])).entries()]
      .map(([dirName, workspace]) => ({
        dirName,
        workspace,
        rows: topics.filter((topic) => (topic.workspace?.dirName ?? "unknown") === dirName),
      }))
      .sort((a, b) => (a.workspace?.basename ?? a.dirName).localeCompare(b.workspace?.basename ?? b.dirName));
    $("#topics").innerHTML = groups
      .map((group) => `
        <button class="group-title group-title-button" type="button" data-project="${escapeHtml(group.dirName)}">${escapeHtml(workspaceLabel(group.workspace) || group.dirName)} (${group.rows.length})</button>
        ${group.rows.map(renderTopicRow).join("")}
      `)
      .join("");
    return;
  }
  const groups = ["active", "stale", "archived"];
  $("#topics").innerHTML = groups
    .map((group) => {
      const rows = topics.filter((topic) => topic.lifecycle === group);
      if (rows.length === 0) return "";
      return `
        <div class="group-title">${group.toUpperCase()} (${rows.length})</div>
        ${rows.map(renderTopicRow).join("")}
      `;
    })
    .join("");
}

function renderTopicRow(topic) {
  const key = topicKey(topic);
  const running = data.running.some((run) => (run.topicKey ?? run.topic) === key && run.pidAlive);
  const verdicts = topic.rounds.map((round) => round.verdict);
  const hasMissingTranscript = topic.rounds.some((round) => round.sessionId && !hasTranscript(round));
  const worst = verdicts.includes("error")
    ? "error"
    : verdicts.includes("blocked")
      ? "blocked"
      : verdicts.includes("advisory")
        ? "advisory"
        : verdicts.includes("ok")
          ? "ok"
          : "";
  return `
    <button class="topic-row ${key === state.selectedTopic ? "is-selected" : ""}" data-topic="${key}" data-lifecycle="${topic.lifecycle}">
      <div class="topic-main">
        <span class="topic-slug mono">${highlight(topic.slug)}</span>
        <span class="mono dim">${topic.roundCount}r</span>
        <span class="mono dim" data-live="topic-ago" data-started-at="${topic.lastUsedAt}" data-running="${running ? "1" : "0"}">${ago(topic.lastUsedAt)}${running ? " run" : ""}</span>
      </div>
      <div class="topic-summary">
        ${worst ? `<span class="swatch ${worst}"></span>` : ""}
        ${state.selectedProject === PROJECT_ALL ? `<span class="micro-flag">${escapeHtml(topic.lifecycle)}</span>` : ""}
        ${hasMissingTranscript ? `<span class="micro-flag">missing transcript</span>` : ""}
        <span>${highlight(topic.summary ?? "No summary")}</span>
      </div>
      ${state.selectedProject === PROJECT_ALL ? `<div class="topic-workspace mono">${escapeHtml(topic.workspace?.root ?? "")}</div>` : ""}
    </button>
  `;
}

function renderWorkspaceSelect() {
  const select = $("#workspace-select");
  if (!select) return;
  const current = select.value;
  const options = [
    `<option value="${PROJECT_ALL}">All projects</option>`,
    ...workspaces().map((workspace) => {
      const count = data.topics.filter((topic) => (topic.workspace?.dirName ?? data.workspace.dirName) === workspace.dirName).length;
      const label = `${workspace.basename}${count ? ` (${count})` : ""}`;
      return `<option value="${escapeHtml(workspace.dirName)}">${escapeHtml(label)}</option>`;
    }),
  ].join("");
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = selectedProjectExists() ? state.selectedProject : PROJECT_ALL;
  if (current !== select.value) localStorage.setItem("handoff:selectedProject", select.value);
}

function renderTimeline() {
  const topic = selectedTopic();
  if (!topic) {
    $("#topic-header").innerHTML = "";
    $("#timeline").innerHTML = "";
    return;
  }
  const topicWorkspace = topic.workspace ?? data.workspace;
  const round = selectedRound(topic);
  const roundMeta = round
    ? `#${pad(round.index, 3)} ${handoffRoute(round)} · ${round.mode} · ${fmtTime(round.startedAt)}`
    : "No round selected";
  $("#topic-header").innerHTML = `
    <div class="topic-kicker">
      <span class="mono">${escapeHtml(roundMeta)}</span>
      <span class="mono">${escapeHtml(topic.lifecycle)}</span>
    </div>
    <h1 class="mono">${escapeHtml(topic.slug)}</h1>
    <p>${escapeHtml(topic.summary ?? "No summary recorded.")}</p>
    ${state.selectedProject === PROJECT_ALL ? `<div class="session-line"><span class="session-chip">${escapeHtml(topicWorkspace.root ?? "")}</span></div>` : ""}
  `;
  const rounds = visibleRounds(topic);
  const querySuffix = state.query.trim() ? ` | ${rounds.length} match${rounds.length === 1 ? "" : "es"}` : "";
  if (!rounds.length) {
    $("#timeline").innerHTML = state.query.trim()
      ? `<div class="empty-state"><strong>No matching rounds</strong><span>Clear search or inspect the full topic timeline.</span></div>`
      : `<div class="empty-state"><strong>No invocation events</strong><span>Topic metadata exists, but no rounds are present in history.jsonl.</span></div>`;
    return;
  }
  $("#timeline").innerHTML = renderMainTranscript(topic, querySuffix);
}

function renderMainTranscript(topic, querySuffix = "") {
  const round = selectedRound(topic);
  if (!round) {
    return `<div class="empty-state"><strong>No round selected</strong><span>Select a round with a session to read its transcript.</span></div>`;
  }
  const transcript = transcriptForRound(round);
  const status = transcriptState(round);
  if (!transcript) {
    return `
      <div class="transcript-main-empty">
        <span class="agent-token agent-${round.agent}">${escapeHtml(agentLabel[round.agent] ?? round.agent)}</span>
        <strong>${escapeHtml(status.label)}</strong>
        <span>${escapeHtml(status.detail)}</span>
        <span class="mono">${escapeHtml(agentLabel[round.agent] ?? round.agent)} · ${escapeHtml(round.sessionId ?? "no session id")}</span>
      </div>
    `;
  }
  const turns = turnsForRound(topic, round, transcript);
  const totalVisible = visibleTranscriptTurns(transcript).length;
  return `
    <div class="transcript-main">
      <div class="transcript-main-head">
        <div>
          <span class="overline">${escapeHtml(round.agent)} transcript</span>
          <strong>#${pad(round.index, 3)} ${escapeHtml(round.mode)} · ${shortId(round.sessionId)}</strong>
        </div>
        <div class="transcript-controls">
          <span class="mono dim">${turns.length}/${totalVisible} in send${querySuffix}</span>
        </div>
      </div>
      <div class="transcript-thread">
        ${turns.length
          ? groupTranscriptTurns(turns).map((item) => renderTranscriptItem(item, round)).join("")
          : `<div class="empty-state"><strong>No transcript turns inside this send window</strong><span>The native session has turns, but none are timestamped between this handoff send and the next send.</span></div>`}
      </div>
    </div>
  `;
}

function renderRelayTimeline() {
  const topic = selectedTopic();
  $("#inspector-title").textContent = "Sends";
  if (!topic) {
    $("#inspector").innerHTML = `<div class="notice">No topic selected.</div>`;
    return;
  }
  const rounds = visibleRounds(topic);
  if (!rounds.length) {
    $("#inspector").innerHTML = `<div class="notice">No matching handoff sends.</div>`;
    return;
  }
  $("#inspector").innerHTML = `
    <div class="handoff-send-list">
      ${rounds.map(renderRelaySend).join("")}
    </div>
  `;
}

function renderRelaySend(round) {
  const transcript = transcriptState(round);
  const selected = round.index === state.selectedRound;
  const durationAttrs = round.isRunning
    ? ` data-live="round-duration" data-started-at="${round.startedAt}"`
    : "";
  return `
    <button class="handoff-send ${selected ? "is-selected" : ""} ${round.isRunning ? "is-running" : ""}" data-round="${round.index}" data-agent="${round.agent}">
      <span class="handoff-send-head">
        <span class="mono">#${pad(round.index, 3)}</span>
        <strong>${escapeHtml(handoffRoute(round))}</strong>
        <span>${round.mode}</span>
        <span>${fmtTime(round.startedAt)}</span>
      </span>
      <span class="handoff-send-preview">${highlight(round.promptPreview)}</span>
      <span class="handoff-send-foot">
        <span class="verdict"><span class="swatch ${round.verdict}"></span>${round.verdict}</span>
        <span${durationAttrs}>${round.isRunning ? elapsedSince(round.startedAt) : fmtDuration(round.durationMs)}</span>
        <span title="${escapeHtml(transcript.detail)}">${transcript.label}</span>
      </span>
    </button>
  `;
}

function displaySender(turn, normalized, round) {
  if (normalized.kind === "assistant") return agentLabel[round.agent] ?? round.agent;
  if (normalized.kind === "user") return handoffRoute(round);
  if (normalized.kind === "tool") return normalized.title;
  if (normalized.kind === "tool_result") return "tool result";
  return normalized.label;
}

function renderTranscriptItem(item, round) {
  if (item.kind === "tool_pair") return renderToolPair(item, round);
  return renderTranscriptBubble(item.turn, round, item.normalized);
}

function displaySource(turn, normalized, round) {
  if (normalized.kind === "assistant") return agentLabel[round.agent] ?? round.agent;
  if (normalized.kind === "user") return "handoff";
  if (normalized.kind === "tool" || normalized.kind === "tool_result") return "tool";
  return normalized.label;
}

function renderTranscriptBubble(turn, round, alreadyNormalized = null) {
  const normalized = alreadyNormalized ?? normalizeTurn(turn);
  const sender = displaySender(turn, normalized, round);
  const source = displaySource(turn, normalized, round);
  const hasBody = normalized.text.length > 0;
  if (normalized.markerOnly) {
    return `
      <article class="transcript-event transcript-${normalized.kind}" data-role="${escapeHtml(turn.role)}">
        <span class="event-kind">${escapeHtml(sender)}</span>
        <span class="event-role">${escapeHtml(source)}</span>
        <span class="event-time">${fmtTime(turn.ts)}</span>
      </article>
    `;
  }
  const isLong = normalized.kind === "system" && (normalized.text.length > 2400 || normalized.text.split("\n").length > 60);
  const body = (normalized.kind === "tool" || normalized.kind === "tool_result") && hasBody
    ? renderToolBody(normalized)
    : hasBody
      ? isLong
        ? `<details class="turn-expand"><summary>${escapeHtml(normalized.title)} · ${normalized.text.length} chars</summary><div class="turn-body markdown-body">${renderMarkdown(normalized.text)}</div></details>`
        : `<div class="turn-body markdown-body">${renderMarkdown(normalized.text)}</div>`
      : `<div class="turn-body dim">${escapeHtml(normalized.title)}</div>`;
  return `
    <article class="transcript-turn transcript-${normalized.kind}" data-role="${escapeHtml(turn.role)}">
      <div class="turn-head">
        <span><span class="turn-kind">${escapeHtml(sender)}</span><span class="turn-role">${escapeHtml(source)}</span></span>
        <span>${fmtTime(turn.ts)}</span>
      </div>
      ${body}
    </article>
  `;
}

function renderToolPair(item, round) {
  const call = item.call;
  const result = item.result;
  const callNorm = item.callNormalized;
  const resultNorm = item.resultNormalized;
  const resultText = resultNorm?.text ?? "";
  const hasInput = callNorm.text.length > 0;
  const hasResult = resultText.length > 0;
  const errorClass = result?.isError ? " is-error" : "";
  const fileToolClass = /^(read|write|edit|multiedit)$/i.test(callNorm.title) ? " is-file-tool" : "";
  return `
    <article class="transcript-tool-pair${errorClass}${fileToolClass}" data-role="${escapeHtml(call.role)}">
      <div class="tool-pair-head">
        <span>
          <span class="turn-kind">${escapeHtml(callNorm.title)}</span>
          <span class="turn-role">tool</span>
          ${call.toolUseId ? `<span class="tool-id mono">${escapeHtml(shortId(call.toolUseId))}</span>` : ""}
        </span>
        <span>${fmtTime(call.ts)}${result?.ts ? ` -> ${fmtTime(result.ts)}` : ""}</span>
      </div>
      <div class="tool-pair-grid">
        <details class="tool-detail"${hasInput ? " open" : ""}>
          <summary><span>input</span><span>${callNorm.text.length} chars</span></summary>
          ${hasInput ? renderCodeBlock(callNorm.text, "json") : `<div class="tool-empty">No input captured.</div>`}
        </details>
        <details class="tool-detail"${hasResult ? " open" : ""}>
          <summary><span>${result?.isError ? "error" : "result"}</span><span>${resultText.length} chars</span></summary>
          ${hasResult ? renderCodeBlock(resultText, "") : `<div class="tool-empty">No result captured.</div>`}
        </details>
      </div>
    </article>
  `;
}

function renderToolBody(normalized) {
  const label = normalized.kind === "tool"
    ? `${normalized.title} input`
    : "tool output";
  const open = normalized.text.length < 3200 ? " open" : "";
  const language = normalized.kind === "tool" ? "json" : "";
  return `
    <details class="tool-detail"${open}>
      <summary><span>${escapeHtml(label)}</span><span>${normalized.text.length} chars</span></summary>
      ${renderCodeBlock(normalized.text, language)}
    </details>
  `;
}

window.RelayUiInteractions.bindInteractions({
  $,
  state,
  selectedTopic,
  selectedRound,
  visibleRounds,
  selectFirstVisibleRound,
  render,
  refreshProductionData,
  updateLiveControls,
  kbdGuard,
});

setInterval(() => {
  if (!document.hidden) refreshLiveText();
}, 1000);

void loadProductionData().then(() => render());
})();
