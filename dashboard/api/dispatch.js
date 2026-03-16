"use strict";

const ALLOWED_ACTIONS = new Set(["sync", "start", "end"]);
const WORKFLOW_FILE = "dashboard-sync.yml";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const adminKey = process.env.DASHBOARD_ADMIN_KEY;
  const providedKey = req.headers["x-dashboard-key"];
  if (!adminKey || providedKey !== adminKey) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_REF || "main";
  const githubToken = process.env.GITHUB_TOKEN;

  if (!repository || !githubToken) {
    res.status(500).json({ error: "Server is missing GitHub configuration." });
    return;
  }

  const body = parseBody(req.body);
  const action = String(body.action || "").trim().toLowerCase();
  const project = String(body.project || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) {
    res.status(400).json({ error: "Invalid action." });
    return;
  }

  if (action === "sync" && project) {
    res.status(400).json({ error: "Sync action must target all projects." });
    return;
  }

  if ((action === "start" || action === "end") && !project) {
    res.status(400).json({ error: "Project is required for this action." });
    return;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "velocity-dashboard-api",
      },
      body: JSON.stringify({
        ref,
        inputs: {
          mode: action,
          project,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    res.status(response.status).json({ error: errorText || "GitHub dispatch failed." });
    return;
  }

  res.status(202).json({
    ok: true,
    message:
      action === "sync"
        ? "Refresh started for all projects."
        : `${action === "start" ? "Sprint start refresh" : "Sprint end refresh"} started for ${project}.`,
  });
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (_err) {
      return {};
    }
  }
  return body;
}
