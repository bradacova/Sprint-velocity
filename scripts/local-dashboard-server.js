#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(__dirname, "..");
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const LOG_DIR = path.join(ROOT, "logs");
const ACTION_LOG = path.join(LOG_DIR, "local-dashboard-actions.log");
const TOKEN_SOURCE = path.resolve("/Users/bradacova/.codex/memories/velocity-dashboard-sync.sh");
const NODE_BIN = "/opt/homebrew/bin/node";
const SHAREPOINT_EXPORT = path.join(
  "/Users/bradacova/Library/CloudStorage/OneDrive-SharedLibraries-Shoptet,a.s/Product Department - Velocity dashboard",
  "velocity-sprints.json"
);
const DEFAULT_ADMIN_KEY = "velocity-local-admin";

fs.mkdirSync(LOG_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "POST" && (url.pathname === "/api/dispatch" || url.pathname === "/dashboard/api/dispatch")) {
      await handleDispatch(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    if (url.pathname === "/") {
      redirect(res, "/dashboard/");
      return;
    }

    if (url.pathname.startsWith("/dashboard/")) {
      serveDashboardFile(url.pathname, req.method, res);
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local dashboard server running at http://${HOST}:${PORT}/dashboard/`);
  console.log(`Refresh button admin key: ${process.env.DASHBOARD_ADMIN_KEY || DEFAULT_ADMIN_KEY}`);
});

async function handleDispatch(req, res) {
  const adminKey = process.env.DASHBOARD_ADMIN_KEY || DEFAULT_ADMIN_KEY;
  const providedKey = req.headers["x-dashboard-key"];
  if (providedKey !== adminKey) {
    sendJson(res, 401, { error: "Unauthorized." });
    return;
  }

  const body = await readJsonBody(req);
  const action = String(body.action || "").trim().toLowerCase();
  const project = String(body.project || "").trim();
  if (!["sync", "start", "end"].includes(action)) {
    sendJson(res, 400, { error: "Invalid action." });
    return;
  }
  if (action !== "sync" && !project) {
    sendJson(res, 400, { error: "Project is required for this action." });
    return;
  }

  const token = readGithubToken();
  if (!token) {
    sendJson(res, 500, { error: "Missing local GitHub token configuration." });
    return;
  }

  const child = spawn("/bin/zsh", ["-lc", buildActionCommand(action, project)], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GITHUB_TOKEN: token,
    },
  });
  child.unref();

  sendJson(res, 202, {
    ok: true,
    message:
      action === "sync"
        ? "Refresh started for all projects."
        : `${action === "start" ? "Sprint start refresh" : "Sprint end refresh"} started for ${project}.`,
  });
}

function buildActionCommand(action, project) {
  const escapedProject = shellEscape(project);
  const exportSource = shellEscape(path.join(ROOT, "dashboard/data/sharepoint-list.json"));
  const exportTarget = shellEscape(SHAREPOINT_EXPORT);
  const syncScript = shellEscape(path.join(ROOT, "scripts/sync-dashboard-from-github.js"));
  const exportScript = shellEscape(path.join(ROOT, "scripts/export-sharepoint-list.js"));
  const workdir = shellEscape(ROOT);
  const logFile = shellEscape(ACTION_LOG);

  if (action === "sync") {
    return [
      `cd ${workdir}`,
      `echo "[` + `$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')` + `] sync start" >> ${logFile}`,
      `${shellEscape(NODE_BIN)} ${syncScript} --mode sync --project "" >> ${logFile} 2>&1`,
      `${shellEscape(NODE_BIN)} ${exportScript} ${shellEscape(path.join(ROOT, "dashboard/data/sprints.json"))} ${exportSource} >> ${logFile} 2>&1`,
      `/bin/cp ${exportSource} ${exportTarget} >> ${logFile} 2>&1`,
      `echo "[` + `$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')` + `] sync finish" >> ${logFile}`,
    ].join(" && ");
  }

  return [
    `cd ${workdir}`,
    `echo "[` + `$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')` + `] ${action} start: ${escapedProject}" >> ${logFile}`,
    `${shellEscape(NODE_BIN)} ${syncScript} --mode ${shellEscape(action)} --project ${escapedProject} >> ${logFile} 2>&1`,
    `${shellEscape(NODE_BIN)} ${exportScript} ${shellEscape(path.join(ROOT, "dashboard/data/sprints.json"))} ${exportSource} >> ${logFile} 2>&1`,
    `/bin/cp ${exportSource} ${exportTarget} >> ${logFile} 2>&1`,
    `echo "[` + `$(/bin/date '+%Y-%m-%d %H:%M:%S %Z')` + `] ${action} finish: ${escapedProject}" >> ${logFile}`,
  ].join(" && ");
}

function serveDashboardFile(pathname, method, res) {
  let relativePath = pathname.replace(/^\/dashboard\//, "");
  if (!relativePath) relativePath = "index.html";
  const filePath = path.normalize(path.join(DASHBOARD_DIR, relativePath));
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, err.code === "ENOENT" ? 404 : 500, { error: "File not found." });
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType(filePath));
    const stat = fs.statSync(filePath);
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    if (method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  });
}

function readGithubToken() {
  if (!fs.existsSync(TOKEN_SOURCE)) return "";
  const content = fs.readFileSync(TOKEN_SOURCE, "utf8");
  const match = content.match(/export GITHUB_TOKEN="([^"]+)"/);
  return match ? match[1] : "";
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}
