#!/usr/bin/env node
"use strict";

const REQUIRED_ENVS = ["GITHUB_TOKEN", "PROJECT_OWNER", "PROJECT_NUMBER", "REPO"];

const CONFIG = {
  sprintFieldName: process.env.SPRINT_FIELD_NAME || "Sprint",
  spOriginFieldName: process.env.SP_ORIGIN_FIELD_NAME || "SP origin",
  spFieldName: process.env.SP_FIELD_NAME || "SP",
  spStartFieldName: process.env.SP_START_FIELD_NAME || "SP start",
  spStartIterationFieldName:
    process.env.SP_START_ITERATION_FIELD_NAME || "SP start iteration",
  dashboardIssueTitle: process.env.DASHBOARD_ISSUE_TITLE || "Sprint Velocity Dashboard",
};

const GH_API = "https://api.github.com/graphql";
const REST_API = "https://api.github.com";
const today = new Date();
const todayISO = isoDate(today);

async function main() {
  validateEnv();

  const project = await getProject();
  const fields = mapFields(project.fields.nodes);

  const sprintField = fields.get(CONFIG.sprintFieldName);
  const spOriginField = fields.get(CONFIG.spOriginFieldName);
  const spField = fields.get(CONFIG.spFieldName);
  const spStartField = fields.get(CONFIG.spStartFieldName);
  const spStartIterationField = fields.get(CONFIG.spStartIterationFieldName);

  assertField(sprintField, CONFIG.sprintFieldName);
  assertField(spOriginField, CONFIG.spOriginFieldName);
  assertField(spField, CONFIG.spFieldName);
  assertField(spStartField, CONFIG.spStartFieldName);
  assertField(spStartIterationField, CONFIG.spStartIterationFieldName);

  if (sprintField.type !== "ProjectV2IterationField") {
    throw new Error(`Field "${CONFIG.sprintFieldName}" must be an Iteration field.`);
  }

  const activeIteration = findActiveIteration(sprintField.configuration.iterations || []);
  if (activeIteration) {
    await snapshotStartPoints(project.id, activeIteration, {
      sprintFieldId: sprintField.id,
      spOriginFieldId: spOriginField.id,
      spFieldId: spField.id,
      spStartFieldId: spStartField.id,
      spStartIterationFieldId: spStartIterationField.id,
    });
  } else {
    console.log("No active sprint iteration found for snapshot.");
  }

  const latestCompleted = findLatestCompleted(
    sprintField.configuration.completedIterations || []
  );
  if (!latestCompleted) {
    console.log("No completed sprint iteration found for reporting.");
    return;
  }

  const allItems = await getProjectItems(project.id);
  const sprintItems = allItems
    .map((item) => readItem(item, fields))
    .filter((item) => item.iterationId === latestCompleted.id);

  const report = buildReport(sprintItems, latestCompleted);
  await upsertDashboardIssue(report, latestCompleted.id);
  console.log(`Dashboard updated for sprint: ${latestCompleted.title}`);
}

function validateEnv() {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function mapFields(fieldNodes) {
  const map = new Map();
  for (const field of fieldNodes || []) {
    if (!field?.name) continue;
    map.set(field.name, field);
  }
  return map;
}

function assertField(field, name) {
  if (!field) {
    throw new Error(`Project field "${name}" not found.`);
  }
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
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

function findActiveIteration(iterations) {
  return iterations.find((it) => {
    const { start, endExclusive } = iterationWindow(it);
    return today >= start && today < endExclusive;
  });
}

function findLatestCompleted(completedIterations) {
  if (!completedIterations.length) return null;
  const sorted = [...completedIterations].sort((a, b) => {
    const endA = iterationWindow(a).endInclusive;
    const endB = iterationWindow(b).endInclusive;
    return endB - endA;
  });
  return sorted[0];
}

async function snapshotStartPoints(projectId, activeIteration, fieldIds) {
  const items = await getProjectItems(projectId);
  let updates = 0;
  for (const rawItem of items) {
    const values = normalizeFieldValues(rawItem.fieldValues.nodes || []);
    const iteration = values.iterationByFieldId.get(fieldIds.sprintFieldId);
    if (!iteration || iteration.iterationId !== activeIteration.id) continue;

    const currentSnapshotIteration = values.textByFieldId.get(
      fieldIds.spStartIterationFieldId
    );
    if (currentSnapshotIteration === activeIteration.id) continue;

    const spCurrent = values.numberByFieldId.get(fieldIds.spFieldId);
    const spOrigin = values.numberByFieldId.get(fieldIds.spOriginFieldId);
    const startValue = spCurrent ?? spOrigin;
    if (typeof startValue !== "number") continue;

    await updateNumberField(projectId, rawItem.id, fieldIds.spStartFieldId, startValue);
    await updateTextField(
      projectId,
      rawItem.id,
      fieldIds.spStartIterationFieldId,
      activeIteration.id
    );
    updates += 1;
  }
  console.log(`Snapshot updated for ${updates} item(s) in active sprint ${activeIteration.title}.`);
}

function readItem(item, fieldsByName) {
  const values = normalizeFieldValues(item.fieldValues.nodes || []);
  const sprintFieldId = fieldsByName.get(CONFIG.sprintFieldName).id;
  const spOriginFieldId = fieldsByName.get(CONFIG.spOriginFieldName).id;
  const spFieldId = fieldsByName.get(CONFIG.spFieldName).id;
  const spStartFieldId = fieldsByName.get(CONFIG.spStartFieldName).id;
  const spStartIterationFieldId = fieldsByName.get(CONFIG.spStartIterationFieldName).id;

  const iterationValue = values.iterationByFieldId.get(sprintFieldId);
  const spOrigin = values.numberByFieldId.get(spOriginFieldId);
  const spEnd = values.numberByFieldId.get(spFieldId) ?? 0;
  const spStart = values.numberByFieldId.get(spStartFieldId);
  const snapshotIterationId = values.textByFieldId.get(spStartIterationFieldId);
  const startBaseline = typeof spStart === "number" ? spStart : spOrigin;
  const delivered =
    typeof startBaseline === "number" ? Math.max(0, startBaseline - spEnd) : null;

  return {
    url: item.content?.url || "",
    number: item.content?.number,
    title: item.content?.title || "Untitled",
    iterationId: iterationValue?.iterationId || null,
    snapshotIterationId: snapshotIterationId || null,
    spStart: typeof startBaseline === "number" ? startBaseline : null,
    spEnd,
    delivered,
  };
}

function buildReport(items, iteration) {
  const rows = [];
  let totalStart = 0;
  let totalEnd = 0;
  let totalDelivered = 0;

  const usable = items.filter((it) => typeof it.spStart === "number");
  for (const item of usable) {
    const delivered = round2(item.delivered ?? 0);
    totalStart += item.spStart;
    totalEnd += item.spEnd;
    totalDelivered += delivered;
    const issue = item.number ? `#${item.number}` : "(draft)";
    const link = item.url ? `[${issue}](${item.url})` : issue;
    rows.push(`| ${link} | ${escapePipes(item.title)} | ${fmt(item.spStart)} | ${fmt(item.spEnd)} | ${fmt(delivered)} |`);
  }

  rows.sort((a, b) => a.localeCompare(b));

  const missingSnapshots = items.filter(
    (it) =>
      typeof it.spStart !== "number" || it.snapshotIterationId !== iteration.id
  );

  const { start, endInclusive } = iterationWindow(iteration);
  const header = [
    `# Sprint Velocity Dashboard`,
    ``,
    `## ${iteration.title}`,
    `Sprint dates: ${isoDate(start)} to ${isoDate(endInclusive)}`,
    `Updated: ${todayISO}`,
    ``,
    `### Totals`,
    `- Planned SP at sprint start: **${fmt(totalStart)}**`,
    `- Remaining SP at sprint end: **${fmt(totalEnd)}**`,
    `- Delivered SP in sprint: **${fmt(totalDelivered)}**`,
    ``,
    `### Items`,
    `| Issue | Title | SP Start | SP End | Delivered |`,
    `|---|---|---:|---:|---:|`,
    rows.length ? rows.join("\n") : "| - | No items found | - | - | - |",
    ``,
  ];

  if (missingSnapshots.length) {
    header.push(
      `### Warnings`,
      `Some items are missing a valid sprint-start snapshot for this sprint (${missingSnapshots.length} item(s)).`,
      `These items are excluded or fallback to SP origin when available.`,
      ``
    );
  }

  header.push(`<!-- LAST_REPORTED_ITERATION_ID:${iteration.id} -->`);
  return header.join("\n");
}

function fmt(num) {
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function round2(num) {
  return Math.round(num * 100) / 100;
}

function escapePipes(text) {
  return String(text).replace(/\|/g, "\\|");
}

function normalizeFieldValues(nodes) {
  const numberByFieldId = new Map();
  const textByFieldId = new Map();
  const iterationByFieldId = new Map();

  for (const node of nodes) {
    const fieldId = node.field?.id;
    if (!fieldId) continue;
    if (node.__typename === "ProjectV2ItemFieldNumberValue") {
      numberByFieldId.set(fieldId, node.number);
    } else if (node.__typename === "ProjectV2ItemFieldTextValue") {
      textByFieldId.set(fieldId, node.text);
    } else if (node.__typename === "ProjectV2ItemFieldIterationValue") {
      iterationByFieldId.set(fieldId, {
        iterationId: node.iterationId,
        title: node.title,
      });
    }
  }

  return { numberByFieldId, textByFieldId, iterationByFieldId };
}

async function getProject() {
  const query = `
    query GetProject($owner: String!, $number: Int!) {
      organization(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            nodes {
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
                  completedIterations {
                    id
                    title
                    startDate
                    duration
                  }
                }
              }
              ... on ProjectV2SingleSelectField {
                id
                name
              }
            }
          }
        }
      }
    }
  `;

  const res = await ghGraphQL(query, {
    owner: process.env.PROJECT_OWNER,
    number: Number(process.env.PROJECT_NUMBER),
  });
  const project = res.organization?.projectV2;
  if (!project) {
    throw new Error("Project not found. Check PROJECT_OWNER and PROJECT_NUMBER.");
  }
  return project;
}

async function getProjectItems(projectId) {
  const all = [];
  let hasNextPage = true;
  let cursor = null;

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
              content {
                ... on Issue {
                  number
                  title
                  url
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
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldIterationValue {
                    iterationId
                    title
                    field {
                      ... on ProjectV2FieldCommon {
                        id
                        name
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

  while (hasNextPage) {
    const res = await ghGraphQL(query, { projectId, cursor });
    const items = res.node.items.nodes || [];
    all.push(...items);
    hasNextPage = res.node.items.pageInfo.hasNextPage;
    cursor = res.node.items.pageInfo.endCursor;
  }
  return all;
}

async function upsertDashboardIssue(body, iterationId) {
  const [owner, repo] = process.env.REPO.split("/");
  if (!owner || !repo) {
    throw new Error("REPO must be in owner/repo format.");
  }

  const issues = await ghRest(
    `/repos/${owner}/${repo}/issues?state=open&per_page=100`
  );
  let issue = issues.find((i) => i.title === CONFIG.dashboardIssueTitle);

  if (issue && issue.body?.includes(`LAST_REPORTED_ITERATION_ID:${iterationId}`)) {
    console.log("Latest completed sprint already reported, skipping update.");
    return;
  }

  if (!issue) {
    issue = await ghRest(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: {
        title: CONFIG.dashboardIssueTitle,
        body,
      },
    });
    console.log(`Created dashboard issue #${issue.number}`);
    return;
  }

  await ghRest(`/repos/${owner}/${repo}/issues/${issue.number}`, {
    method: "PATCH",
    body: { body },
  });
}

async function updateNumberField(projectId, itemId, fieldId, number) {
  const mutation = `
    mutation UpdateNumber(
      $projectId: ID!,
      $itemId: ID!,
      $fieldId: ID!,
      $number: Float!
    ) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { number: $number }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  await ghGraphQL(mutation, { projectId, itemId, fieldId, number });
}

async function updateTextField(projectId, itemId, fieldId, text) {
  const mutation = `
    mutation UpdateText(
      $projectId: ID!,
      $itemId: ID!,
      $fieldId: ID!,
      $text: String!
    ) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { text: $text }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  await ghGraphQL(mutation, { projectId, itemId, fieldId, text });
}

async function ghGraphQL(query, variables) {
  const res = await fetch(GH_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "sprint-velocity-automation",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const details = JSON.stringify(json.errors || json, null, 2);
    throw new Error(`GraphQL request failed: ${details}`);
  }
  return json.data;
}

async function ghRest(path, options = {}) {
  const res = await fetch(`${REST_API}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "sprint-velocity-automation",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`REST request failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
