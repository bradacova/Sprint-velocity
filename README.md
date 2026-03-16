# Sprint Velocity Automation

This repository contains a GitHub Actions automation that calculates delivered story points per sprint using your rules:

- Sprint baseline for each item = `SP start` captured at sprint start.
- Delivered SP for each item = `SP start - SP`.
- Carried-over work uses remaining `SP` as next sprint baseline (not `SP origin`).

## What it does

1. On each run, it finds the active iteration in your `Sprint` field.
2. For items in that active sprint, it stores a one-time snapshot:
   - `SP start` = current `SP` (fallback to `SP origin` if needed)
   - `SP start iteration` = sprint iteration ID
3. It finds the latest completed sprint and updates a dashboard issue with:
   - total planned SP at sprint start
   - total remaining SP at sprint end
   - total delivered SP
   - item-level table

## Required project fields

In your GitHub Project (v2), keep these fields:

- `SP origin` (Number)
- `SP` (Number)
- `Sprint` (Iteration)

Add these two fields:

- `SP start` (Number)
- `SP start iteration` (Text)

## Required repo settings

Set repository **Variables**:

- `PROJECT_OWNER`: org/user that owns the project
- `PROJECT_NUMBER`: project number (for example `12`)

Set repository **Secret**:

- `PROJECTS_TOKEN`: GitHub token with rights to read/update Project v2 items and write issues

Recommended token scopes for a PAT:

- `repo`
- `project`

## Workflow schedule

Workflow: `.github/workflows/sprint-velocity.yml`

- Runs weekdays at `23:00 UTC`
- Also supports manual run (`workflow_dispatch`)

Adjust the cron to match your sprint cadence/time zone.

## Dashboard output

The workflow creates or updates issue:

- `Sprint Velocity Dashboard`

It contains a markdown table with per-item delivered SP and sprint totals.

## Local Browser Dashboard

A local dashboard is available for sprint history and velocity trends:

- Open: `/Users/bradacova/Documents/Github velocity/dashboard/index.html`
- Data source: `/Users/bradacova/Documents/Github velocity/dashboard/data/sprints.json`

### Run locally

From `/Users/bradacova/Documents/Github velocity`:

```bash
python3 -m http.server 8080
```

Then open [http://localhost:8080/dashboard/](http://localhost:8080/dashboard/).

### Dashboard action buttons on Vercel

The dashboard UI includes these actions:

- `Refresh Data` updates all configured projects.
- `Refresh Beginning of Sprint` resets the active sprint baseline for the selected project.
- `Refresh End of Sprint` finalizes the selected project's active sprint.

These buttons are meant for the Vercel deployment. They trigger the GitHub Actions workflow `dashboard-sync.yml` through a Vercel API route.

Set these Vercel environment variables for the deployed dashboard:

- `GITHUB_TOKEN`: token allowed to dispatch workflows in this repository
- `GITHUB_REPOSITORY`: repository in `owner/repo` format
- `GITHUB_REF`: branch to dispatch on (for example `main`)
- `DASHBOARD_ADMIN_KEY`: shared secret entered in the dashboard when you click a button

The daily cron schedule remains unchanged.

### Update history

Add one object per sprint under `sprints` in `dashboard/data/sprints.json`:

- `project`
- `sprint_number`
- `period`
- `status` (`completed` or `in_progress`)
- `planned_sp`
- `delivered_sp` (`null` until known)
- `remaining_sp`
- `notes`

Optional scope-change fields (recommended):

- `scope_added_sp` (total SP added after sprint start)
- `scope_removed_sp` (total SP removed after sprint start)
- `scope_added_tasks` (array of `{ id, title, sp_start }`)
- `scope_removed_tasks` (array of `{ id, title, sp_start }`)
- Per-task `scope_change`: `baseline`, `added`, or `removed`
- Per-task `from`: if filled, task is counted as cross-team work (work done for other teams)

Dashboard behavior:

- `planned_sp` stays frozen as the sprint commitment.
- Current scope is shown separately: `planned_sp + scope_added_sp - scope_removed_sp`.
- Cross-team share is calculated automatically:
  - Sprint level: `cross-team % = (sum of SP start for tasks with non-empty from) / planned_sp`
  - Team level: average of sprint cross-team percentages across completed sprints

## GitHub API Sync (No Screenshots)

Use this script to pull all teams directly from GitHub Projects and update dashboard data:

- Script: `/Users/bradacova/Documents/Github velocity/scripts/sync-dashboard-from-github.js`
- Config: `/Users/bradacova/Documents/Github velocity/dashboard/config/projects.json`
- Snapshot store: `/Users/bradacova/Documents/Github velocity/dashboard/data/api-snapshots.json`

### 1) Configure projects

Edit `dashboard/config/projects.json`:

- Set `owner` and `project_number` for each team.
- Keep field names aligned with your project fields:
  - `Sprint`, `SP`, `SP origin`, `Status`, `From`
- Set done states in `done_status_values` (default: `Resolved`).

### 2) Set GitHub token

Export token with `project` and `repo` scopes:

```bash
export GITHUB_TOKEN="YOUR_TOKEN_HERE"
```

### 3) Run sync

```bash
node scripts/sync-dashboard-from-github.js
```

This updates:

- `dashboard/data/sprints.json` (dashboard source)
- `dashboard/data/api-snapshots.json` (baseline/scope tracking for active sprints)

### Notes

- Planned SP is frozen from the first API snapshot for each active sprint.
- Scope change is tracked after that first snapshot:
  - new items in sprint => `scope_change: added`
  - removed items from sprint => `scope_change: removed`
- If a task is in a done status, effective `SP end = 0`.
