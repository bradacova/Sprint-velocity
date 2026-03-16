#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const GH_API = "https://api.github.com/graphql";
const TODAY = new Date();

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || "dashboard/config/projects.json");
const dataPath = path.resolve(args.data || "dashboard/data/sprints.json");
const snapshotPath = path.resolve(args.snapshots || "dashboard/data/api-snapshots.json");
const mode = normalizeMode(args.mode);

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN env variable.");
  }

  const cfg = readJson(configPath);
  const allProjectsCfg = Array.isArray(cfg.projects) ? cfg.projects : [];
  const projectsCfg = filterProjects(allProjectsCfg, args.project);
  if (!projectsCfg.length) {
    throw new Error(`No projects found in ${configPath}.`);
  }

  const dashboard = readJson(dataPath);
  if (!Array.isArray(dashboard.sprints)) dashboard.sprints = [];
  if (!Array.isArray(dashboard.projects)) dashboard.projects = [];

  const snapshots = safeReadJson(snapshotPath, { projects: {} });
  if (!snapshots.projects || typeof snapshots.projects !== "object") {
    snapshots.projects = {};
  }

  for (const projectCfg of projectsCfg) {
    validateProjectConfig(projectCfg);
    const runResult = await syncProject(projectCfg, snapshots, { mode });
    if (!runResult) continue;
    upsertSprint(dashboard.sprints, runResult.sprintEntry);
    if (!dashboard.projects.includes(projectCfg.name)) {
      dashboard.projects.push(projectCfg.name);
    }
    console.log(
      `Synced ${projectCfg.name} ${runResult.sprintEntry.sprint_label}: ` +
        `planned=${fmt(runResult.sprintEntry.planned_sp)} ` +
        `remaining=${fmt(runResult.sprintEntry.remaining_sp)} ` +
        `delivered=${fmt(runResult.sprintEntry.delivered_sp)}`
    );
  }

  dashboard.projects = sortProjects(dashboard.projects, allProjectsCfg.map((p) => p.name));
  dashboard.meta = {
    last_updated_at: TODAY.toISOString(),
    last_action: mode,
    last_project: args.project || "ALL",
  };
  writeJson(dataPath, dashboard);
  writeJson(snapshotPath, snapshots);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config") out.config = argv[i + 1];
    if (a === "--data") out.data = argv[i + 1];
    if (a === "--snapshots") out.snapshots = argv[i + 1];
    if (a === "--project") out.project = argv[i + 1];
    if (a === "--mode") out.mode = argv[i + 1];
  }
  return out;
}

function normalizeMode(rawMode) {
  const candidate = String(rawMode || "sync").trim().toLowerCase();
  if (["sync", "start", "end"].includes(candidate)) return candidate;
  throw new Error(`Unsupported mode "${rawMode}". Use sync, start, or end.`);
}

function filterProjects(projectsCfg, targetProject) {
  if (!targetProject) return projectsCfg;

  const normalizedTarget = normalizeFieldName(targetProject);
  const filtered = projectsCfg.filter(
    (projectCfg) => normalizeFieldName(projectCfg.name) === normalizedTarget
  );

  if (!filtered.length) {
    throw new Error(`Project "${targetProject}" not found in dashboard/config/projects.json.`);
  }

  return filtered;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function safeReadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  return readJson(p);
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function validateProjectConfig(cfg) {
  const required = ["name", "owner", "project_number", "field_names"];
  for (const key of required) {
    if (!cfg[key]) throw new Error(`Project config "${cfg.name || "unknown"}" missing ${key}.`);
  }
  const fields = cfg.field_names;
  for (const k of ["sprint", "sp", "sp_origin", "status", "from"]) {
    if (!fields[k]) throw new Error(`Project ${cfg.name} missing field_names.${k}.`);
  }
}

async function syncProject(projectCfg, snapshots, options) {
  const project = await getProject(projectCfg.owner, Number(projectCfg.project_number));
  if (!project) {
    console.log(`Project not found for ${projectCfg.name}, skipping.`);
    return null;
  }

  const fieldNodes = project.fields.nodes || [];
  const fieldMap = mapFields(fieldNodes);
  const sprintField = resolveField(projectCfg, fieldNodes, fieldMap, "sprint", [
    "ProjectV2IterationField",
  ]);
  const spField = resolveField(projectCfg, fieldNodes, fieldMap, "sp");
  const spOriginField = resolveField(projectCfg, fieldNodes, fieldMap, "sp_origin");
  const statusField = resolveField(projectCfg, fieldNodes, fieldMap, "status");
  const fromField = resolveField(projectCfg, fieldNodes, fieldMap, "from");
  const includeTypes = Array.isArray(projectCfg.include_types)
    ? new Set(projectCfg.include_types.map((v) => String(v).trim()).filter(Boolean))
    : null;
  const includeRoles = Array.isArray(projectCfg.include_roles)
    ? new Set(projectCfg.include_roles.map((v) => String(v).trim()).filter(Boolean))
    : null;
  const includeFieldValues = Array.isArray(projectCfg.include_field_values)
    ? new Set(projectCfg.include_field_values.map((v) => String(v).trim()).filter(Boolean))
    : null;
  let typeField = null;
  if (includeTypes && includeTypes.size) {
    try {
      typeField = resolveField(projectCfg, fieldNodes, fieldMap, "type");
    } catch (_err) {
      console.log(
        `${projectCfg.name}: no project Type field, using issue type from item content.`
      );
    }
  }
  const roleField =
    includeRoles && includeRoles.size
      ? resolveField(projectCfg, fieldNodes, fieldMap, "role")
      : null;
  const includeField =
    includeFieldValues && includeFieldValues.size && projectCfg.include_field_name
      ? resolveFieldByName(projectCfg, fieldNodes, fieldMap, projectCfg.include_field_name)
      : null;
  for (const [name, field] of [
    ["sp", spField],
    ["sp_origin", spOriginField],
    ["status", statusField],
    ["from", fromField],
  ]) {
    if (!field) throw new Error(`${projectCfg.name}: missing configured ${name} field.`);
  }

  const activeIteration = findActiveIteration(sprintField.configuration.iterations || []);
  if (!activeIteration) {
    console.log(`${projectCfg.name}: no active sprint iteration, skipping.`);
    return null;
  }

  const allItems = await getProjectItems(project.id);
  const parsed = allItems.map((item) =>
    parseItem(item, {
      sprintFieldId: sprintField.id,
      spFieldId: spField.id,
      spOriginFieldId: spOriginField.id,
      statusFieldId: statusField.id,
      fromFieldId: fromField.id,
      typeFieldId: typeField?.id,
      roleFieldId: roleField?.id,
      includeFieldId: includeField?.id,
    })
  );

  const sprintItems = parsed.filter(
    (it) =>
      it.iterationId === activeIteration.id &&
      !it.isArchived &&
      matchesTypeFilter(it, includeTypes) &&
      (!includeRoles || !includeRoles.size || includeRoles.has(String(it.role || "").trim())) &&
      (!includeFieldValues ||
        !includeFieldValues.size ||
        includeFieldValues.has(String(it.includeFieldValue || "").trim()))
  );
  if (options.mode === "start") {
    resetIterationSnapshot(snapshots, projectCfg.name, activeIteration.id);
  }

  const snapshot = ensureIterationSnapshot(snapshots, projectCfg.name, activeIteration);

  hydrateSnapshot(snapshot, sprintItems);
  const sprintEntry = buildSprintEntry(projectCfg, activeIteration, snapshot, sprintItems, {
    mode: options.mode,
  });
  return { sprintEntry };
}

function mapFields(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!n?.name) continue;
    if (!map.has(n.name)) map.set(n.name, []);
    map.get(n.name).push(n);
  }
  return map;
}

function resolveField(projectCfg, fieldNodes, fieldMap, key, allowedTypes = null) {
  const ids = projectCfg.field_ids || {};
  const names = projectCfg.field_names || {};
  const targetId = ids[key];
  const targetName = names[key];

  if (targetId) {
    const byId = fieldNodes.find((f) => f.id === targetId);
    if (!byId) {
      throw new Error(
        `${projectCfg.name}: field_ids.${key}=${targetId} not found. Available: ${listFields(
          fieldNodes
        )}`
      );
    }
    if (allowedTypes && !allowedTypes.includes(byId.__typename)) {
      throw new Error(
        `${projectCfg.name}: field_ids.${key} points to ${byId.__typename}, expected ${allowedTypes.join(
          " or "
        )}.`
      );
    }
    return byId;
  }

  const matches = fieldMap.get(targetName) || [];
  let resolvedMatches = matches;
  if (!resolvedMatches.length) {
    const normalizedTarget = normalizeFieldName(targetName);
    resolvedMatches = fieldNodes.filter(
      (f) => normalizeFieldName(f.name) === normalizedTarget
    );
  }
  if (!resolvedMatches.length) {
    throw new Error(
      `${projectCfg.name}: field "${targetName}" not found for ${key}. Available: ${listFields(
        fieldNodes
      )}`
    );
  }
  const typed = allowedTypes
    ? resolvedMatches.filter((f) => allowedTypes.includes(f.__typename))
    : resolvedMatches;
  if (allowedTypes && typed.length === 0) {
    throw new Error(
      `${projectCfg.name}: field "${targetName}" exists but not with expected type (${allowedTypes.join(
        " or "
      )}). Matches: ${resolvedMatches
        .map((m) => `${m.name}:${m.__typename}`)
        .join(", ")}`
    );
  }
  if (typed.length > 1) {
    throw new Error(
      `${projectCfg.name}: field "${targetName}" for ${key} is ambiguous. Set field_ids.${key}. Matches: ${typed
        .map((m) => `${m.id}:${m.__typename}`)
        .join(", ")}`
    );
  }
  return typed[0];
}

function listFields(nodes) {
  return nodes
    .map((f) => `${f.name} [${f.__typename}]`)
    .sort((a, b) => a.localeCompare(b))
    .join("; ");
}

function resolveFieldByName(projectCfg, fieldNodes, fieldMap, rawName) {
  const byExact = fieldMap.get(rawName) || [];
  let matches = byExact;
  if (!matches.length) {
    const normalized = normalizeFieldName(rawName);
    matches = fieldNodes.filter((f) => normalizeFieldName(f.name) === normalized);
  }
  if (!matches.length) {
    throw new Error(
      `${projectCfg.name}: include_field_name "${rawName}" not found. Available: ${listFields(
        fieldNodes
      )}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${projectCfg.name}: include_field_name "${rawName}" is ambiguous. Matches: ${matches
        .map((m) => `${m.id}:${m.name}:${m.__typename}`)
        .join(", ")}`
    );
  }
  return matches[0];
}

function normalizeFieldName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchesTypeFilter(item, includeTypes) {
  if (!includeTypes || !includeTypes.size) return true;
  const typeValue = String(item.type || item.issueTypeName || "").trim();
  // If type is missing in API, keep the item instead of dropping real sprint scope.
  if (!typeValue) return true;
  return includeTypes.has(typeValue);
}

function parseItem(item, fieldIds) {
  const values = normalizeFieldValues(item.fieldValues.nodes || []);
  const content = item.content || {};
  const status = values.singleSelectByFieldId.get(fieldIds.statusFieldId) ||
    values.textByFieldId.get(fieldIds.statusFieldId) ||
    "";
  const from = values.singleSelectByFieldId.get(fieldIds.fromFieldId) ||
    values.textByFieldId.get(fieldIds.fromFieldId) ||
    "";
  const type = fieldIds.typeFieldId
    ? values.singleSelectByFieldId.get(fieldIds.typeFieldId) ||
      values.textByFieldId.get(fieldIds.typeFieldId) ||
      ""
    : "";
  const role = fieldIds.roleFieldId
    ? values.singleSelectByFieldId.get(fieldIds.roleFieldId) ||
      values.textByFieldId.get(fieldIds.roleFieldId) ||
      ""
    : "";
  const includeFieldValue = fieldIds.includeFieldId
    ? values.singleSelectByFieldId.get(fieldIds.includeFieldId) ||
      values.textByFieldId.get(fieldIds.includeFieldId) ||
      ""
    : "";
  const issueTypeName = content.issueType?.name || "";
  return {
    itemId: item.id,
    isArchived: !!item.isArchived,
    title: content.title || "Untitled",
    number: content.number || null,
    url: content.url || "",
    iterationId: values.iterationByFieldId.get(fieldIds.sprintFieldId)?.iterationId || null,
    sp: values.numberByFieldId.get(fieldIds.spFieldId),
    spOrigin: values.numberByFieldId.get(fieldIds.spOriginFieldId),
    status: status || "",
    from: from || "",
    type: type || "",
    role: role || "",
    includeFieldValue: includeFieldValue || "",
    issueTypeName,
  };
}

function ensureIterationSnapshot(store, projectName, iteration) {
  if (!store.projects[projectName]) {
    store.projects[projectName] = { iterations: {} };
  }
  const projectStore = store.projects[projectName];
  if (!projectStore.iterations) projectStore.iterations = {};
  if (!projectStore.iterations[iteration.id]) {
    projectStore.iterations[iteration.id] = {
      iteration_id: iteration.id,
      title: iteration.title,
      start_date: iteration.startDate,
      duration: iteration.duration,
      created_at: TODAY.toISOString(),
      initialized: false,
      planned_sp: 0,
      items: {},
    };
  }
  return projectStore.iterations[iteration.id];
}

function resetIterationSnapshot(store, projectName, iterationId) {
  if (!store.projects[projectName]?.iterations?.[iterationId]) return;
  delete store.projects[projectName].iterations[iterationId];
}

function hydrateSnapshot(snapshot, sprintItems) {
  // First snapshot for this iteration: freeze entire current sprint scope as baseline.
  if (!snapshot.initialized) {
    snapshot.items = {};
    snapshot.planned_sp = 0;
    for (const item of sprintItems) {
      const spStart = toNumber(item.sp, item.spOrigin, 0);
      snapshot.items[item.itemId] = {
        item_id: item.itemId,
        issue_number: item.number,
        title: item.title,
        url: item.url,
        sp_start: spStart,
        scope_change: "baseline",
        first_seen_at: TODAY.toISOString(),
      };
      snapshot.planned_sp = round2(snapshot.planned_sp + spStart);
    }
    snapshot.initialized = true;
    return;
  }

  const activeIds = new Set(sprintItems.map((i) => i.itemId));
  for (const item of sprintItems) {
    const existing = snapshot.items[item.itemId];
    if (!existing) {
      const spStart = toNumber(item.sp, item.spOrigin, 0);
      const scopeChange = "added";
      snapshot.items[item.itemId] = {
        item_id: item.itemId,
        issue_number: item.number,
        title: item.title,
        url: item.url,
        sp_start: spStart,
        scope_change: scopeChange,
        first_seen_at: TODAY.toISOString(),
      };
      if (scopeChange === "baseline") snapshot.planned_sp = round2(snapshot.planned_sp + spStart);
      continue;
    }

    existing.issue_number = item.number;
    existing.title = item.title;
    existing.url = item.url;
    existing.removed_at = null;
  }

  for (const [itemId, snapItem] of Object.entries(snapshot.items)) {
    if (!activeIds.has(itemId)) {
      if (!snapItem.removed_at) snapItem.removed_at = TODAY.toISOString();
    }
  }

  // If we started snapshot mid-sprint and first run had existing items, they are baseline.
  // Ensure planned_sp exists.
  if (!snapshot.planned_sp || snapshot.planned_sp < 0) {
    snapshot.planned_sp = round2(
      Object.values(snapshot.items)
        .filter((i) => i.scope_change === "baseline")
        .reduce((a, i) => a + toNumber(i.sp_start, 0), 0)
    );
  }
}

function buildSprintEntry(projectCfg, iteration, snapshot, sprintItems, options) {
  const activeById = new Map(sprintItems.map((i) => [i.itemId, i]));
  const doneValues = new Set((projectCfg.done_status_values || ["Resolved"]).map((s) => s.trim()));

  const tasks = [];
  let scopeAddedSp = 0;
  let scopeRemovedSp = 0;
  const addedTasks = [];
  const removedTasks = [];
  let remainingSp = 0;

  const sortedSnapshotItems = Object.values(snapshot.items).sort((a, b) => {
    if (a.issue_number && b.issue_number) return a.issue_number - b.issue_number;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  for (const snapItem of sortedSnapshotItems) {
    const scopeChange = snapItem.removed_at ? "removed" : snapItem.scope_change || "baseline";
    const spStart = toNumber(snapItem.sp_start, 0);
    const active = activeById.get(snapItem.item_id);

    if (snapItem.scope_change === "added") {
      scopeAddedSp += spStart;
      addedTasks.push({ id: issueId(snapItem), title: snapItem.title, sp_start: spStart });
    }
    if (scopeChange === "removed") {
      scopeRemovedSp += spStart;
      removedTasks.push({ id: issueId(snapItem), title: snapItem.title, sp_start: spStart });
      tasks.push({
        id: issueId(snapItem),
        title: snapItem.title,
        status: "Removed",
        from: "",
        scope_change: "removed",
        sp_start: spStart,
        sp_end: null,
        delivered: null,
      });
      continue;
    }

    const status = active?.status || "";
    const done = doneValues.has(status);
    const spCurrent = toNumber(active?.sp, spStart);
    const spEnd = done ? 0 : spCurrent;
    const delivered = round2(Math.max(0, spStart - spEnd));
    remainingSp += spEnd;

    tasks.push({
      id: issueId(snapItem),
      title: active?.title || snapItem.title,
      status,
      from: active?.from || "",
      scope_change: snapItem.scope_change || "baseline",
      sp_start: spStart,
      sp_end: round2(spEnd),
      delivered,
    });
  }

  const planned = round2(toNumber(snapshot.planned_sp, 0));
  const currentScope = round2(planned + scopeAddedSp - scopeRemovedSp);
  const remaining = round2(remainingSp);
  const delivered = round2(Math.max(0, currentScope - remaining));
  const { start, endInclusive } = iterationWindow(iteration);

  return {
    project: projectCfg.name,
    sprint_number: parseSprintNumber(iteration.title),
    sprint_label: iteration.title,
    period: `${isoDate(start)} to ${isoDate(endInclusive)}`,
    status: options.mode === "end" ? "completed" : "in_progress",
    planned_sp: planned,
    delivered_sp: delivered,
    remaining_sp: remaining,
    scope_added_sp: round2(scopeAddedSp),
    scope_removed_sp: round2(scopeRemovedSp),
    scope_added_tasks: addedTasks,
    scope_removed_tasks: removedTasks,
    notes:
      options.mode === "start"
        ? "Sprint baseline refreshed from GitHub API."
        : options.mode === "end"
          ? "Sprint finalized from GitHub API."
          : "Synced from GitHub API.",
    tasks,
  };
}

function upsertSprint(sprints, entry) {
  const idx = sprints.findIndex(
    (s) => s.project === entry.project && Number(s.sprint_number) === Number(entry.sprint_number)
  );
  if (idx < 0) {
    sprints.push(entry);
    return;
  }

  const previous = sprints[idx];
  if (String(previous.status || "").toLowerCase() === "completed") {
    return;
  }
  const merged = { ...previous, ...entry };

  // Preserve removed tasks already known in history even if current API snapshot
  // started after those removals and no longer contains them.
  const prevTasks = Array.isArray(previous.tasks) ? previous.tasks : [];
  const newTasks = Array.isArray(entry.tasks) ? entry.tasks : [];
  const byId = new Map(newTasks.map((t) => [t.id, t]));
  for (const t of prevTasks) {
    if ((t.scope_change || "") === "removed" && !byId.has(t.id)) {
      newTasks.push(t);
    }
  }
  merged.tasks = newTasks;

  const prevRemoved = Array.isArray(previous.scope_removed_tasks)
    ? previous.scope_removed_tasks
    : [];
  const newRemoved = Array.isArray(entry.scope_removed_tasks)
    ? entry.scope_removed_tasks
    : [];
  const removedMap = new Map(newRemoved.map((t) => [t.id, t]));
  for (const t of prevRemoved) {
    if (!removedMap.has(t.id)) newRemoved.push(t);
  }
  merged.scope_removed_tasks = newRemoved;

  // Keep scope_removed_sp consistent with preserved removed tasks.
  const removedSpFromTasks = round2(
    newRemoved.reduce((acc, t) => acc + toNumber(t.sp_start, 0), 0)
  );
  merged.scope_removed_sp = removedSpFromTasks;
  merged.tasks = merged.tasks.sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));

  sprints[idx] = merged;
}

function sortProjects(existing, preferred) {
  const unique = Array.from(new Set(existing));
  const prefSet = new Set(preferred);
  const ordered = preferred.filter((p) => unique.includes(p));
  const rest = unique.filter((p) => !prefSet.has(p)).sort();
  return ordered.concat(rest);
}

async function getProject(owner, number) {
  const orgQuery = `
    query GetOrgProject($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          title
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
              }
              ... on ProjectV2IterationField {
                id
                name
                configuration {
                  iterations {
                    id
                    title
                    startDate
                    duration
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  const orgData = await ghGraphQL(orgQuery, { owner, number });
  if (orgData.organization?.projectV2) return orgData.organization.projectV2;

  const userQuery = `
    query GetUserProject($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          id
          title
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
              }
              ... on ProjectV2IterationField {
                id
                name
                configuration {
                  iterations {
                    id
                    title
                    startDate
                    duration
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const userData = await ghGraphQL(userQuery, { owner, number });
    return userData.user?.projectV2 || null;
  } catch (err) {
    if (String(err.message).includes("Could not resolve to a User")) return null;
    throw err;
  }
}

async function getProjectItems(projectId) {
  const all = [];
  let cursor = null;
  let hasNext = true;

  const query = `
    query GetItems($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isArchived
              content {
                ... on Issue {
                  number
                  title
                  url
                  issueType {
                    name
                  }
                }
                ... on PullRequest {
                  number
                  title
                  url
                }
              }
              fieldValues(first: 100) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldNumberValue {
                    number
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldIterationValue {
                    iterationId
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  while (hasNext) {
    const data = await ghGraphQL(query, { projectId, cursor });
    const conn = data.node.items;
    all.push(...(conn.nodes || []));
    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
  }
  return all;
}

function normalizeFieldValues(nodes) {
  const numberByFieldId = new Map();
  const textByFieldId = new Map();
  const singleSelectByFieldId = new Map();
  const iterationByFieldId = new Map();

  for (const node of nodes) {
    const fieldId = node.field?.id;
    if (!fieldId) continue;
    if (node.__typename === "ProjectV2ItemFieldNumberValue") {
      numberByFieldId.set(fieldId, node.number);
    } else if (node.__typename === "ProjectV2ItemFieldTextValue") {
      textByFieldId.set(fieldId, node.text || "");
    } else if (node.__typename === "ProjectV2ItemFieldSingleSelectValue") {
      singleSelectByFieldId.set(fieldId, node.name || "");
    } else if (node.__typename === "ProjectV2ItemFieldIterationValue") {
      iterationByFieldId.set(fieldId, { iterationId: node.iterationId });
    }
  }

  return { numberByFieldId, textByFieldId, singleSelectByFieldId, iterationByFieldId };
}

function findActiveIteration(iterations) {
  return iterations.find((it) => {
    const { start, endExclusive } = iterationWindow(it);
    return TODAY >= start && TODAY < endExclusive;
  });
}

function parseSprintNumber(title) {
  const match = String(title || "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function issueId(item) {
  return item.issue_number ? `#${item.issue_number}` : "(draft)";
}

function parseDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function iterationWindow(iteration) {
  const start = parseDate(iteration.startDate);
  const endExclusive = addDays(start, iteration.duration);
  const endInclusive = addDays(endExclusive, -1);
  return { start, endExclusive, endInclusive };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function ghGraphQL(query, variables) {
  const res = await fetch(GH_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "dashboard-sync",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL failed: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
