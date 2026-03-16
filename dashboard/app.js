const DATA_PATH = "./data/sprints.json";

const projectTabs = document.getElementById("projectTabs");
const summaryRoot = document.getElementById("summary");
const chartWrap = document.getElementById("chartWrap");
const tableBody = document.querySelector("#historyTable tbody");
const teamVelocityBody = document.querySelector("#teamVelocityTable tbody");
const lastUpdatedRoot = document.getElementById("lastUpdated");
const refreshAllBtn = document.getElementById("refreshAllBtn");
const startSprintBtn = document.getElementById("startSprintBtn");
const endSprintBtn = document.getElementById("endSprintBtn");
const actionHintRoot = document.getElementById("actionHint");
const actionStatusRoot = document.getElementById("actionStatus");
let activeProject = "ALL";

init().catch((err) => {
  if (lastUpdatedRoot) {
    lastUpdatedRoot.textContent = "Last data update: unavailable";
  }
  chartWrap.innerHTML = `<p class="error">Failed to load data: ${escapeHtml(err.message)}</p>`;
});

async function init() {
  const res = await fetch(DATA_PATH, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} while loading sprint data`);
  const payload = await res.json();
  const sprints = payload.sprints || [];
  const projects = Array.isArray(payload.projects) && payload.projects.length
    ? payload.projects
    : Array.from(new Set(sprints.map((r) => r.project))).sort();
  const lastUpdated = parseLastUpdated(payload.meta?.last_updated_at || res.headers.get("last-modified"));

  renderLastUpdated(lastUpdated);
  renderProjectTabs(projects, sprints);
  wireActions();
  updateActionState();
  render(sprints);
}

function renderLastUpdated(lastUpdated) {
  if (!lastUpdatedRoot) return;

  if (!lastUpdated) {
    lastUpdatedRoot.textContent = "Last data update: unavailable";
    return;
  }

  lastUpdatedRoot.textContent = `Last data update: ${formatDateTime(lastUpdated)}`;
}

function renderProjectTabs(projects, rows) {
  if (!projects.length) {
    activeProject = "ALL";
    projectTabs.innerHTML = "";
    return;
  }

  const validValues = new Set([...projects, "ALL"]);
  if (!validValues.has(activeProject)) activeProject = projects[0];

  const tabs = projects
    .map((p) => {
      const selected = p === activeProject;
      return `<button type="button" class="tab-btn" role="tab" aria-selected="${selected ? "true" : "false"}" data-project="${escapeHtml(
        p
      )}">${escapeHtml(p)}</button>`;
    })
    .concat(
      `<button type="button" class="tab-btn all-tab" role="tab" aria-selected="${activeProject === "ALL" ? "true" : "false"}" data-project="ALL">All</button>`
    )
    .join("");
  projectTabs.innerHTML = tabs;

  projectTabs.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeProject = btn.getAttribute("data-project") || "ALL";
      renderProjectTabs(projects, rows);
      updateActionState();
      render(rows);
    });
  });
}

function wireActions() {
  if (refreshAllBtn) {
    refreshAllBtn.addEventListener("click", () => triggerAction("sync"));
  }
  if (startSprintBtn) {
    startSprintBtn.addEventListener("click", () => triggerAction("start", activeProject));
  }
  if (endSprintBtn) {
    endSprintBtn.addEventListener("click", () => triggerAction("end", activeProject));
  }
}

function updateActionState() {
  const hasProject = activeProject !== "ALL";
  if (startSprintBtn) startSprintBtn.disabled = !hasProject;
  if (endSprintBtn) endSprintBtn.disabled = !hasProject;
  if (!actionHintRoot) return;

  actionHintRoot.textContent = hasProject
    ? `Selected project: ${activeProject}. Sprint start/end actions will run only for this project.`
    : "Refresh Data updates all projects. Select one project to enable sprint start/end actions.";
}

async function triggerAction(action, project = "") {
  try {
    setActionStatus("Working...");
    setButtonsBusy(true);
    const adminKey = await getAdminKey();
    const response = await fetch("./api/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-dashboard-key": adminKey,
      },
      body: JSON.stringify({ action, project: action === "sync" ? "" : project }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        sessionStorage.removeItem("velocity-dashboard-admin-key");
      }
      throw new Error(payload.error || `Request failed with HTTP ${response.status}`);
    }

    setActionStatus(
      `${payload.message} Local sync is running. Refresh the page in a minute or two.`
    );
  } catch (err) {
    setActionStatus(`Action failed: ${err.message}`, true);
  } finally {
    setButtonsBusy(false);
  }
}

async function getAdminKey() {
  const stored = sessionStorage.getItem("velocity-dashboard-admin-key");
  if (stored) return stored;

  const entered = window.prompt("Enter the dashboard admin key:");
  if (!entered) {
    throw new Error("Dashboard admin key is required.");
  }

  sessionStorage.setItem("velocity-dashboard-admin-key", entered);
  return entered;
}

function setButtonsBusy(isBusy) {
  for (const button of [refreshAllBtn, startSprintBtn, endSprintBtn]) {
    if (!button) continue;
    button.disabled = isBusy || (button !== refreshAllBtn && activeProject === "ALL");
  }
}

function setActionStatus(message, isError = false) {
  if (!actionStatusRoot) return;
  actionStatusRoot.textContent = message;
  actionStatusRoot.dataset.state = isError ? "error" : "info";
}

function render(rows) {
  const filtered = activeProject === "ALL" ? rows : rows.filter((r) => r.project === activeProject);
  renderSummary(filtered);
  renderTeamVelocity(filtered);
  renderChart(filtered);
  renderTable(filtered);
}

function renderTeamVelocity(rows) {
  const scopedRows =
    activeProject === "ALL" ? rows : rows.filter((r) => r.project === activeProject);

  const byProject = new Map();
  for (const r of scopedRows) {
    if (!byProject.has(r.project)) {
      byProject.set(r.project, []);
    }
    byProject.get(r.project).push(r);
  }

  const tableRows = Array.from(byProject.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, sprints]) => {
      const completed = sprints.filter((s) => s.status === "completed");
      const completedCount = completed.length;
      const totalDelivered = sum(completed.map((s) => num(s.delivered_sp)));
      const totalPlanned = sum(completed.map((s) => num(s.planned_sp)));
      const avgCrossTeamPct = completedCount
        ? sum(completed.map((s) => getCrossTeam(s).pct)) / completedCount
        : null;
      const avgDelivered = completedCount ? totalDelivered / completedCount : null;
      const avgPlanned = completedCount ? totalPlanned / completedCount : null;
      const rate = totalPlanned > 0 ? (totalDelivered / totalPlanned) * 100 : null;

      return `
        <tr>
          <td>${escapeHtml(project)}</td>
          <td>${completedCount}</td>
          <td>${avgDelivered == null ? "-" : formatNum(avgDelivered)}</td>
          <td>${avgPlanned == null ? "-" : formatNum(avgPlanned)}</td>
          <td>${avgCrossTeamPct == null ? "-" : `${formatNum(avgCrossTeamPct)}%`}</td>
          <td>${rate == null ? "-" : `${formatNum(rate)}%`}</td>
        </tr>
      `;
    })
    .join("");

  teamVelocityBody.innerHTML =
    tableRows ||
    `<tr><td colspan="6" class="muted">No sprint data available yet.</td></tr>`;
}

function renderSummary(rows) {
  const complete = rows.filter((r) => r.status === "completed");
  const totalPlanned = sum(complete.map((r) => num(r.planned_sp)));
  const totalDelivered = sum(complete.map((r) => num(r.delivered_sp)));
  const totalCurrentScope = sum(complete.map((r) => getScope(r).current));
  const avgCrossAll = rows.length
    ? sum(rows.map((r) => getCrossTeam(r).pct)) / rows.length
    : 0;
  const avgPlanned = complete.length ? totalPlanned / complete.length : 0;
  const avgDelivered = complete.length ? totalDelivered / complete.length : 0;
  const predictability = totalPlanned ? (totalDelivered / totalPlanned) * 100 : 0;
  const scopeExecution = totalCurrentScope ? (totalDelivered / totalCurrentScope) * 100 : 0;

  const cards = [
    statCard("Avg planned SP", formatNum(avgPlanned)),
    statCard("Avg delivered SP", formatNum(avgDelivered)),
    statCard("Avg cross-team %", `${formatNum(avgCrossAll)}%`),
    statCard("Predictability (vs plan)", `${formatNum(predictability)}%`),
    statCard("Execution (vs scope)", `${formatNum(scopeExecution)}%`),
  ];
  summaryRoot.innerHTML = cards.join("");
}

function renderChart(rows) {
  const complete = rows
    .filter((r) => r.status === "completed")
    .sort((a, b) => a.sprint_number - b.sprint_number);

  if (!complete.length) {
    chartWrap.innerHTML = `<p class="muted">No completed sprint data to chart yet.</p>`;
    return;
  }

  const labels = complete.map((r) => `S${r.sprint_number}`);
  const planned = complete.map((r) => num(r.planned_sp));
  const delivered = complete.map((r) => num(r.delivered_sp));
  const maxY = Math.max(1, ...planned, ...delivered);
  const width = Math.max(700, labels.length * 110);
  const height = 280;
  const pad = { top: 20, right: 20, bottom: 50, left: 40 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const x = (i) =>
    pad.left + (labels.length === 1 ? chartW / 2 : (i / (labels.length - 1)) * chartW);
  const y = (v) => pad.top + chartH - (v / maxY) * chartH;

  const poly = (vals) => vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const pointsPlanned = poly(planned);
  const pointsDelivered = poly(delivered);

  const xLabels = labels
    .map(
      (label, i) =>
        `<text x="${x(i)}" y="${height - 18}" text-anchor="middle" class="axis">${escapeHtml(
          label
        )}</text>`
    )
    .join("");

  const yTicks = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => Math.round(maxY * t))
    .map(
      (tick) => `
      <line x1="${pad.left}" y1="${y(tick)}" x2="${width - pad.right}" y2="${y(
        tick
      )}" class="grid"/>
      <text x="${pad.left - 8}" y="${y(tick) + 4}" text-anchor="end" class="axis">${tick}</text>
    `
    )
    .join("");

  const dots = (vals, klass) =>
    vals
      .map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" class="${klass}" />`)
      .join("");

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Planned vs delivered trend">
      ${yTicks}
      <polyline points="${pointsPlanned}" class="line planned" />
      <polyline points="${pointsDelivered}" class="line delivered" />
      ${dots(planned, "dot planned")}
      ${dots(delivered, "dot delivered")}
      ${xLabels}
    </svg>
    <div class="legend">
      <span><i class="swatch planned"></i> Planned (blue)</span>
      <span><i class="swatch delivered"></i> Delivered (green)</span>
    </div>
  `;
}

function renderTable(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.sprint_number !== b.sprint_number) return b.sprint_number - a.sprint_number;
    return a.project.localeCompare(b.project);
  });

  tableBody.innerHTML = sorted
    .map((r, idx) => {
      const planned = num(r.planned_sp);
      const delivered = r.delivered_sp == null ? null : num(r.delivered_sp);
      const remaining = r.remaining_sp == null ? null : num(r.remaining_sp);
      const scope = getScope(r);
      const cross = getCrossTeam(r);
      const pctPlanned = delivered == null || !planned ? null : (delivered / planned) * 100;
      const pctScope = delivered == null || !scope.current ? null : (delivered / scope.current) * 100;
      const rowId = `sprint-row-${idx}`;
      const hasTasks = Array.isArray(r.tasks) && r.tasks.length > 0;
      const toggle = hasTasks
        ? `<button class="expand-btn" aria-expanded="false" aria-controls="${rowId}">Details</button>`
        : `<span class="muted">-</span>`;

      return `
        <tr class="summary-row">
          <td>${toggle}</td>
          <td>${escapeHtml(r.project)}</td>
          <td>${escapeHtml(String(r.sprint_number))}</td>
          <td>${escapeHtml(r.period || "")}</td>
          <td><span class="status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${formatNum(cross.pct)}%</td>
          <td>${formatMaybe(planned)}</td>
          <td>${formatMaybe(scope.added)}</td>
          <td>${formatMaybe(scope.removed)}</td>
          <td>${formatMaybe(scope.current)}</td>
          <td>${formatMaybe(delivered)}</td>
          <td>${formatMaybe(remaining)}</td>
          <td>${pctPlanned == null ? "-" : `${formatNum(pctPlanned)}%`}</td>
          <td>${pctScope == null ? "-" : `${formatNum(pctScope)}%`}</td>
        </tr>
        <tr id="${rowId}" class="details-row" hidden>
          <td colspan="14">
            ${
              hasTasks
                ? buildTaskTable(r.tasks, {
                    planned,
                    current: scope.current,
                    added: scope.added,
                    removed: scope.removed,
                    crossTeamPct: cross.pct,
                    crossTeamSp: cross.crossSp,
                    denominatorSp: cross.denominatorSp,
                    addedTasks: r.scope_added_tasks || [],
                    removedTasks: r.scope_removed_tasks || [],
                  })
                : `<p class="muted">No task details saved for this sprint.</p>`
            }
          </td>
        </tr>
      `;
    })
    .join("");

  if (!sorted.length) {
    tableBody.innerHTML = `<tr><td colspan="14" class="muted">No sprints recorded for this project yet.</td></tr>`;
  }

  wireAccordion();
}

function wireAccordion() {
  const buttons = tableBody.querySelectorAll(".expand-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("aria-controls");
      const row = document.getElementById(targetId);
      if (!row) return;
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
      row.hidden = expanded;
    });
  });
}

function buildTaskTable(tasks, scopeMeta) {
  const rows = [...tasks]
    .sort((a, b) => {
      const rankA = statusSortRank(a.status);
      const rankB = statusSortRank(b.status);
      if (rankA !== rankB) return rankA - rankB;
      const idA = String(a.id || "");
      const idB = String(b.id || "");
      return idA.localeCompare(idB);
    })
    .map((t) => {
      const delivered = t.delivered == null ? null : num(t.delivered);
      const scopeChange = t.scope_change || "baseline";
      const fromValue = (t.from || "").trim();
      return `
        <tr>
          <td>${escapeHtml(t.id || "")}</td>
          <td>${escapeHtml(t.title || "")}</td>
          <td>${escapeHtml(t.status || "")}</td>
          <td>${fromValue ? escapeHtml(fromValue) : "-"}</td>
          <td><span class="scope-chip ${escapeHtml(scopeChange)}">${escapeHtml(scopeChange)}</span></td>
          <td>${formatMaybe(t.sp_start == null ? null : num(t.sp_start))}</td>
          <td>${formatMaybe(t.sp_end == null ? null : num(t.sp_end))}</td>
          <td>${formatMaybe(delivered)}</td>
        </tr>
      `;
    })
    .join("");

  const addedList = (scopeMeta.addedTasks || [])
    .map((t) => `${escapeHtml(t.id || "")} (${formatMaybe(num(t.sp_start || 0))} SP)`)
    .join(", ");
  const removedList = (scopeMeta.removedTasks || [])
    .map((t) => `${escapeHtml(t.id || "")} (${formatMaybe(num(t.sp_start || 0))} SP)`)
    .join(", ");

  return `
    <div class="details-wrap">
      <div class="scope-meta">
        <span><strong>Planned (locked):</strong> ${formatMaybe(scopeMeta.planned)}</span>
        <span><strong>Scope +:</strong> ${formatMaybe(scopeMeta.added)}</span>
        <span><strong>Scope -:</strong> ${formatMaybe(scopeMeta.removed)}</span>
        <span><strong>Current scope:</strong> ${formatMaybe(scopeMeta.current)}</span>
        <span><strong>Cross-team:</strong> ${formatNum(scopeMeta.crossTeamPct)}% (${formatNum(scopeMeta.crossTeamSp)}/${formatNum(scopeMeta.denominatorSp)} SP)</span>
      </div>
      <p class="muted compact"><strong>Added tasks:</strong> ${addedList || "-"}</p>
      <p class="muted compact"><strong>Removed tasks:</strong> ${removedList || "-"}</p>
      <table class="tasks-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Title</th>
            <th>Status</th>
            <th>From</th>
            <th>Scope Change</th>
            <th>SP Start</th>
            <th>SP End</th>
            <th>Delivered</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function getScope(sprint) {
  const planned = num(sprint.planned_sp);
  const addedExplicit = sprint.scope_added_sp;
  const removedExplicit = sprint.scope_removed_sp;
  const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];

  const addedFromTasks = sum(
    tasks
      .filter((t) => t.scope_change === "added")
      .map((t) => num(t.sp_start))
  );
  const removedFromTasks = sum(
    tasks
      .filter((t) => t.scope_change === "removed")
      .map((t) => num(t.sp_start))
  );

  const added = addedExplicit == null ? addedFromTasks : num(addedExplicit);
  const removed = removedExplicit == null ? removedFromTasks : num(removedExplicit);
  const current = planned + added - removed;
  return { added, removed, current };
}

function getCrossTeam(sprint) {
  const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];
  const activeTasks = tasks.filter((t) => (t.scope_change || "baseline") !== "removed");
  const crossTasks = activeTasks.filter((t) => typeof t.from === "string" && t.from.trim() !== "");
  const crossSp = sum(crossTasks.map((t) => num(t.sp_start)));
  const denominatorSp = num(sprint.planned_sp);
  const pct = denominatorSp ? (crossSp / denominatorSp) * 100 : 0;
  return { crossSp, denominatorSp, pct };
}

function statusSortRank(status) {
  const order = [
    "resolved",
    "tested",
    "test in progress",
    "to test",
    "review",
    "in progress",
    "failed",
    "to do",
    "refinement",
  ];
  const normalized = normalizeStatusForSort(status);
  const idx = order.indexOf(normalized);
  return idx === -1 ? 999 : idx;
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeStatusForSort(status) {
  const s = normalizeStatus(status);
  const aliases = {
    "dev review": "review",
    "code review": "review",
    "testing": "to test",
    "test inprogress": "test in progress",
    "inprogress": "in progress",
    "todo": "to do",
  };
  return aliases[s] || s;
}

function statCard(label, value) {
  return `<article class="card stat"><h3>${escapeHtml(label)}</h3><p>${escapeHtml(String(value))}</p></article>`;
}

function sum(vals) {
  return vals.reduce((a, b) => a + b, 0);
}

function num(v) {
  return typeof v === "number" ? v : Number(v || 0);
}

function formatNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function formatMaybe(v) {
  return v == null ? "-" : formatNum(v);
}

function parseLastUpdated(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
