#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const inputPath = path.resolve(process.argv[2] || "dashboard/data/sprints.json");
const outputPath = path.resolve(process.argv[3] || "dashboard/data/sharepoint-list.json");

function main() {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const sprints = Array.isArray(payload.sprints) ? payload.sprints : [];
  const exportedAt = new Date().toISOString();

  const rows = sprints
    .map((sprint) => {
      const planned = toNumber(sprint.planned_sp);
      const added = toNumber(sprint.scope_added_sp);
      const removed = toNumber(sprint.scope_removed_sp);
      const currentScope = round2(planned + added - removed);

      return {
        Key: `${sprint.project}::${sprint.sprint_number}`,
        Project: sprint.project || "",
        "Sprint Number": toNumber(sprint.sprint_number),
        "Sprint Label": sprint.sprint_label || `Sprint ${sprint.sprint_number || ""}`.trim(),
        Period: sprint.period || "",
        Status: sprint.status || "",
        "Planned SP": planned,
        "Delivered SP": sprint.delivered_sp == null ? null : toNumber(sprint.delivered_sp),
        "Remaining SP": sprint.remaining_sp == null ? null : toNumber(sprint.remaining_sp),
        "Scope Added SP": added,
        "Scope Removed SP": removed,
        Notes: sprint.notes || "",
        "Last Updated At": exportedAt,
        "Cross-team %": round2(getCrossTeamPct(sprint)),
        "Current Scope SP": currentScope,
      };
    })
    .sort((a, b) => {
      if (a.Project !== b.Project) return a.Project.localeCompare(b.Project);
      return b["Sprint Number"] - a["Sprint Number"];
    });

  const output = {
    exported_at: exportedAt,
    row_count: rows.length,
    rows,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Exported ${rows.length} rows to ${outputPath}`);
}

function getCrossTeamPct(sprint) {
  const tasks = Array.isArray(sprint.tasks) ? sprint.tasks : [];
  const activeTasks = tasks.filter((task) => (task.scope_change || "baseline") !== "removed");
  const crossSp = activeTasks
    .filter((task) => typeof task.from === "string" && task.from.trim() !== "")
    .reduce((sum, task) => sum + toNumber(task.sp_start), 0);
  const planned = toNumber(sprint.planned_sp);
  return planned ? (crossSp / planned) * 100 : 0;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

main();
