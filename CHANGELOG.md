# Changelog

What changed in each version of GitHub Runner Monitor, newest first, with the steps to take when upgrading. Each release from 2.1.0 on is also a GitHub Release, `vX.Y.Z`, holding its section of this file and the screenshots of its major version.

## 2.1.1

### What changed

- **Shorter side panel.** The theme switch is a round button next to the heading, and the signed in user, Sign out and Personal key follow right after the last item instead of at the bottom of the window.
- **Signed in downloads in CI.** The workflows download gitleaks, kind and Calico from GitHub with the workflow's own token instead of anonymously, so GitHub outages that affect only anonymous downloads (HTTP 504) no longer fail a pull request or a release. The kubectl download retries up to 5 times.

## 2.1.0

### What changed

- **Side panel.** The title, the page buttons and the account moved from the header into a side panel fixed to the left edge of the window: the heading, then Dashboard, Alerts with its count, Debug it settings and Security, and at the bottom the theme switch and the signed in user with a letter avatar, Sign out and Personal key. On a window narrower than 900 pixels a top bar with a menu button opens the same panel as a drawer. Every control keeps its name and does what it did; with Debug it off the panel holds only the heading, Alerts and the theme switch.
- **Screenshots** in the README and docs/images/v2 now show the side panel.
- **Debug run pipeline in the README.** A new section, How a debug run works, shows the Debug run dialog at Analyzing and says in one sentence what happens in each step.

## 2.0.0

### What changed

- **Debug it (new, off by default).** A signed in user who is allowed to use it presses **Debug it** on a failed job in Recent history. Claude reads the job log and the repository's code in an isolated Kubernetes Job in its own namespace, explains why the job failed and suggests a patch. The user follows the run (Waiting, Cloning, Analyzing, Finished), reads the explanation and the patch, and can open each validated part of it as a draft fix pull request, authored by the Debug it GitHub App. Setup is in the README under [Turn on Debug it](README.md#turn-on-debug-it).
- **Sign in with GitHub.** With Debug it on, members of the organization sign in with GitHub, either only for Debug it or for the whole dashboard (`debugIt.loginScope`). Administrators get a **Debug it settings** page for the allowed users and repositories, the startup check result and a usage view.
- **Alert settings for administrators only.** With Debug it on, only a signed in Debug it administrator can change, reset or test the alert settings; reading them stays open. With Debug it off they behave as in 1.x.
- **Failed runs without jobs.** Workflow runs that fail before any job starts, for example because of a broken workflow file, now appear in Recent history. This needs the **Workflow runs** webhook event and works with Debug it on or off.
- **Personal Anthropic keys.** In personal key mode (`debugIt.credentialsMode: personal`) each allowed user saves, replaces and deletes their own Anthropic API key from the dashboard, and their runs use it.
- **Cost telemetry.** Optionally (`debugIt.costTelemetry`), each debug run's cost and tokens are sent to the claude-code-reviewer-cost Grafana dashboard.
- **Safety and the Security page.** A startup check proves the debug namespace is isolated before Debug it turns on, and automatic attack tests must pass before anything is merged or released. [docs/security-design.md](docs/security-design.md) describes the design, and the dashboard's **Security** page summarizes it.
- **One version for everything.** Each release publishes the backend, frontend and new Debug Job images to `bialekamir/github-runner-monitor` as `backend-vX.Y.Z`, `frontend-vX.Y.Z` and `debug-job-vX.Y.Z`, sets the Helm chart's `version` and `appVersion` to the same X.Y.Z and tags the repository `vX.Y.Z`. A GitHub Release with this changelog section and the screenshots follows.
- **Screenshots** in the README now show 2.0.0; the 1.x screenshots are kept in [docs/images/v1](docs/images/v1).

### Upgrade steps

1. **Use the new image tags.** 2.0.0 was never published; upgrade from 1.x straight to 2.1.0. Images are now tagged `backend-v2.1.0`, `frontend-v2.1.0` and `debug-job-v2.1.0` in `bialekamir/github-runner-monitor`, and the chart is version 2.1.0 with appVersion 2.1.0. Install the chart from the `v2.1.0` tag and set `deployment.image.tag` to `backend-v2.1.0` for the backend and `frontend-v2.1.0` for the frontend. The chart picks `debug-job-v<appVersion>` for the Debug Job on its own. The 1.x per-component tags (`backend-v1.0.x`, `frontend-v1.0.x`) are not published any more.
2. **Tick the Workflow runs webhook event.** On the organization webhook (**Settings → Webhooks**, edit it), keep **Workflow jobs** and also tick **Workflow runs**. Without it the monitor works as before and only leaves out failed runs that never started a job.
3. **Debug it stays off unless you turn it on.** Nothing about it runs until `debugIt.enabled` is set to `true` in the backend values; with it off the chart and the backend behave as 1.x. To turn it on, follow [Turn on Debug it](README.md#turn-on-debug-it) and read [Before you turn it on](README.md#before-you-turn-it-on) first.
4. **Alert settings become administrator-only when Debug it is on.** Once `debugIt.enabled` is `true`, changing, resetting or testing the alert settings needs a signed in Debug it administrator (listed in `debugIt.administrators`); anyone else gets 401 or 403, and the dialog shows the values read-only. Reading the alert settings stays open. With Debug it off, alert settings behave exactly as in 1.x. `ALERT_SETTINGS_EDITABLE=false` still makes them read-only for everyone.

## 1.x

The 1.x versions had no per-version tags or notes in this repository; this summarizes what they added up to. The backend and frontend images were published separately as `backend-v1.0.x` and `frontend-v1.0.x`.

- A live dashboard for self-hosted GitHub Actions runners: available runners per pool (available, working, offline), the job queue in estimated order, running jobs and recent history, each job linking to GitHub with its repository, branch, trigger and who started it.
- Sortable columns, paged tables with **Show all**, automatic refresh with each section's age on its heading, and a light and a dark theme.
- Jobs on GitHub's own cloud runners shown as "GitHub Actions (cloud)", and jobs with no known pool as "Unknown".
- Alerts for jobs stuck in the queue and runner pools with no online runner, with an **Alerts** button and count in the header, thresholds and an optional webhook (Slack and Teams compatible) changeable from the **Alert settings** dialog, and `ALERT_SETTINGS_EDITABLE=false` to lock them.
- Job data from a signed organization webhook (**Workflow jobs** event), with optional saving of the job list and alert settings to S3 so they survive a restart.
- Made-up demo data by default, Docker Compose to run it locally and a Helm chart for Kubernetes.
