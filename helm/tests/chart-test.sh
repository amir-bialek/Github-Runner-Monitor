#!/usr/bin/env bash
# Chart tests for the Debug it switch (story 1.2). Needs helm 3 and git with
# the 1.x commit available (CI checks out with fetch-depth 0).
#
#   bash helm/tests/chart-test.sh
#
# Set HELM to use a helm binary that is not on PATH.
set -uo pipefail

HELM="${HELM:-helm}"
BASELINE_1X="526ac7eed3617ea6705d9075aec4cf45431f3932"
RELEASE="runner-monitor"
S3_BUCKET="acme-debug-it-state"

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
chart="$root/helm/chart"
backend="$root/helm/values-backend.yaml"
frontend="$root/helm/values-frontend.yaml"
debug_it="$root/helm/tests/values-debug-it.yaml"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The 1.x chart and values files, straight from the 1.x commit.
mkdir -p "$work/1x"
git -C "$root" archive "$BASELINE_1X" helm | tar -x -C "$work/1x" || {
  echo "Could not read helm/ at the 1.x commit $BASELINE_1X (shallow clone?)" >&2
  exit 2
}
old_chart="$work/1x/helm/chart"
old_backend="$work/1x/helm/values-backend.yaml"
old_frontend="$work/1x/helm/values-frontend.yaml"

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "ok   - $1"; }
fail() { failed=$((failed + 1)); echo "FAIL - $1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/       /'; }

# helm template, minus the chart version labels (the only allowed difference;
# a release sets Chart.yaml version and appVersion, story 8.1).
render() {
  "$HELM" template "$RELEASE" "$@" | grep -vE '^[[:space:]]*(helm\.sh/chart|chart|app\.kubernetes\.io/version):'
}

# The new chart with Debug it on and every required value set, plus overrides.
render_on() {
  "$HELM" template "$RELEASE" "$chart" -f "$backend" -f "$debug_it" \
    --set "deployment.env.regular.JOB_STATE_S3_BUCKET=$S3_BUCKET" "$@" 2>&1
}

expect_same() { # name, old chart args (as one string), new chart args (as one string)
  local name="$1" a b
  # shellcheck disable=SC2086
  a="$(render $2 2>&1)" || { fail "$name (1.x render failed)" "$a"; return; }
  # shellcheck disable=SC2086
  b="$(render $3 2>&1)" || { fail "$name (render failed)" "$b"; return; }
  if [ "$a" == "$b" ]; then pass "$name"; else fail "$name" "$(diff <(echo "$a") <(echo "$b") | head -40)"; fi
}

expect_render_fails() { # name, pattern the message must contain, extra helm args...
  local name="$1" pattern="$2" out
  shift 2
  if out="$(render_on "$@")"; then
    fail "$name (rendered, should have failed)"
  elif grep -qF -- "$pattern" <<<"$out"; then
    pass "$name"
  else
    fail "$name (message does not name '$pattern')" "$out"
  fi
}

contains() { grep -qE -- "$2" <<<"$1"; }

echo "# Off: output equals 1.x apart from chart version labels"
expect_same "1.x backend values"        "$old_chart -f $old_backend"  "$chart -f $old_backend"
expect_same "1.x frontend values"       "$old_chart -f $old_frontend" "$chart -f $old_frontend"
expect_same "new backend values (off)"  "$old_chart -f $backend"      "$chart -f $backend"
expect_same "new frontend values"       "$old_chart -f $frontend"     "$chart -f $frontend"
expect_same "chart defaults only"       "$old_chart"                  "$chart"
expect_same "backend values, debugIt absent" \
  "$old_chart -f $backend --set debugIt=null" "$chart -f $backend --set debugIt=null"

echo "# FR29 defaults in values-backend.yaml"
for line in '^  enabled: false$' '^  credentialsMode: organization$' '^  monthlyCap: 5$' \
  '^  loginScope: debug-it-only$' '^    organizationMonthlySpendLimitUsd: 0$' \
  '^  debugNamespace: debug-it$' '^    maxConcurrentRuns: 3$' '^    maxRunsPerUser: 1$' \
  '^    timeLimitMinutes: 15$' '^    spendLimitUsd: 2$' '^    logLimitBytes: 2097152$' \
  '^    patchLimitBytes: 102400$'; do
  grep -qE -- "$line" "$backend" && pass "default $line" || fail "default $line"
done
grep -A1 -E '^  costTelemetry:$' "$backend" | grep -qE '^    enabled: false$' \
  && pass "default cost telemetry off" || fail "default cost telemetry off"

echo "# Frontend: debugIt values render nothing"
expect_same "frontend values plus enabled debugIt" \
  "$chart -f $frontend" "$chart -f $frontend -f $debug_it"

echo "# On, complete"
if out="$(render_on)"; then
  pass "renders with every required value"
  contains "$out" '^  replicas: 1$' && pass "replicas 1" || fail "replicas 1"
  contains "$out" '^    type: Recreate$' && pass "strategy Recreate" || fail "strategy Recreate"
  contains "$out" 'RollingUpdate' && fail "no RollingUpdate left" || pass "no RollingUpdate left"
  contains "$out" 'kind: HorizontalPodAutoscaler' && fail "no HPA" || pass "no HPA"
  contains "$out" '^kind: Secret' && fail "no kind: Secret" || pass "no kind: Secret"
  missing=""
  for name in DEBUG_IT_ENABLED DEBUG_IT_CREDENTIALS_MODE DEBUG_IT_MONTHLY_CAP DEBUG_IT_LOGIN_SCOPE \
    DEBUG_IT_ADMINISTRATORS DEBUG_IT_ALLOWED_REPOSITORIES DEBUG_IT_ALLOWED_USERS DEBUG_IT_PUBLIC_URL \
    DEBUG_IT_GITHUB_APP_ID DEBUG_IT_GITHUB_APP_CLIENT_ID DEBUG_IT_NAMESPACE DEBUG_IT_MAX_CONCURRENT_RUNS \
    DEBUG_IT_MAX_RUNS_PER_USER DEBUG_IT_TIME_LIMIT_MINUTES DEBUG_IT_SPEND_LIMIT_USD DEBUG_IT_LOG_LIMIT_BYTES \
    DEBUG_IT_PATCH_LIMIT_BYTES DEBUG_IT_ORGANIZATION_MONTHLY_SPEND_LIMIT_USD \
    DEBUG_IT_COST_TELEMETRY_ENABLED DEBUG_IT_COST_TELEMETRY_ENDPOINT; do
    contains "$out" "^        - name: $name\$" || missing="$missing $name"
  done
  [ -z "$missing" ] && pass "every plain DEBUG_IT_* env present" || fail "plain DEBUG_IT_* env missing:$missing"
  contains "$out" 'value: "1000001,1000002"' && pass "lists comma-joined" || fail "lists comma-joined"
  contains "$out" 'value: "2097152"' && pass "whole numbers printed as integers" || fail "whole numbers printed as integers"
  contains "$out" 'value: "2.5"' && pass "decimals kept" || fail "decimals kept"
  for name in DEBUG_IT_GITHUB_APP_PRIVATE_KEY DEBUG_IT_GITHUB_APP_CLIENT_SECRET \
    DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY DEBUG_IT_SESSION_ENCRYPTION_KEY DEBUG_IT_ANTHROPIC_API_KEY; do
    if grep -A3 -E "^        - name: $name\$" <<<"$out" | grep -q 'secretKeyRef:'; then
      pass "$name only as secretKeyRef"
    else
      fail "$name only as secretKeyRef"
    fi
  done
  # Every DEBUG_IT_* entry carrying a secret uses valueFrom, never value.
  if grep -A1 -E '^        - name: DEBUG_IT_.*(KEY|SECRET)$' <<<"$out" | grep -q '^          value:'; then
    fail "no secret env as a plain value"
  else
    pass "no secret env as a plain value"
  fi
else
  fail "renders with every required value" "$out"
fi

echo "# On, story 3.5: debug namespace objects and the Debug Job template"
# One rendered object: the document whose kind and metadata name match.
doc() { # output, kind, name
  awk -v kind="$2" -v name="$3" '
    function flush() { if (k && n) printf "%s", buf; buf = ""; k = 0; n = 0 }
    /^---/ { flush(); next }
    { buf = buf $0 "\n" }
    $0 == "kind: " kind { k = 1 }
    $0 == "  name: " name || $0 == "  name: \"" name "\"" { n = 1 }
    END { flush() }' <<<"$1"
}
if out="$(render_on)"; then
  role="$(doc "$out" Role debug-it-backend)"
  contains "$role" '^  namespace: debug-it$' && pass "Role in the debug namespace" || fail "Role in the debug namespace" "$role"
  rules="$(sed -n '/^rules:/,$p' <<<"$role")"
  expected_rules='rules:
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create", "get", "list", "watch", "delete"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["create", "delete"]'
  [ "$rules" == "$expected_rules" ] && pass "Role has exactly the three rules" || fail "Role has exactly the three rules" "$rules"
  binding="$(doc "$out" RoleBinding debug-it-backend)"
  contains "$binding" '^  namespace: debug-it$' && contains "$binding" '^  name: backend-debug-it$' \
    && contains "$binding" '^  namespace: default$' \
    && pass "RoleBinding binds the backend ServiceAccount" || fail "RoleBinding binds the backend ServiceAccount" "$binding"
  sa="$(doc "$out" ServiceAccount backend-debug-it)"
  [ -n "$sa" ] && pass "backend ServiceAccount rendered" || fail "backend ServiceAccount rendered"
  contains "$out" '^      serviceAccountName: backend-debug-it$' && pass "Deployment uses the backend ServiceAccount" \
    || fail "Deployment uses the backend ServiceAccount"
  contains "$out" 'automountServiceAccountToken: false$' && fail "backend keeps its token" || pass "backend keeps its token"
  jobnp="$(doc "$out" NetworkPolicy debug-it-job)"
  contains "$jobnp" '^  namespace: debug-it$' && contains "$jobnp" '^  - Egress$' \
    && contains "$jobnp" 'cidr: "160.79.104.0/23"' && contains "$jobnp" 'cidr: "2607:6bc0::/48"' \
    && contains "$jobnp" '^      port: 443$' && contains "$jobnp" '^      port: 8080$' \
    && contains "$jobnp" '^    - protocol: UDP$' && contains "$jobnp" '^      port: 53$' \
    && contains "$jobnp" '^      port: 3002$' && contains "$jobnp" 'kubernetes.io/metadata.name: kube-system$' \
    && pass "Debug Job NetworkPolicy" || fail "Debug Job NetworkPolicy" "$jobnp"
  backnp="$(doc "$out" NetworkPolicy backend-debug-it)"
  contains "$backnp" '^  - Ingress$' && ! contains "$backnp" '^  - Egress$' \
    && contains "$backnp" 'kubernetes.io/metadata.name: debug-it$' && contains "$backnp" '^      port: 3002$' \
    && contains "$backnp" '^      port: 3001$' && contains "$backnp" 'app: github-runner-monitor-frontend$' \
    && contains "$backnp" 'kubernetes.io/metadata.name: ingress-nginx$' \
    && pass "backend NetworkPolicy" || fail "backend NetworkPolicy" "$backnp"
  svc="$(doc "$out" Service backend)"
  grep -A3 -E '^    - name: results$' <<<"$svc" | grep -qE '^      port: 3002$' \
    && pass "results port on the backend Service" || fail "results port on the backend Service" "$svc"
  grep -A1 -E '^          - name: results$' <<<"$out" | grep -qE 'containerPort: 3002$' \
    && pass "results containerPort" || fail "results containerPort"
  grep -A4 -E '^        - name: DEBUG_IT_JOB_TEMPLATE$' <<<"$out" | grep -q 'configMapKeyRef:' \
    && pass "DEBUG_IT_JOB_TEMPLATE from the ConfigMap" || fail "DEBUG_IT_JOB_TEMPLATE from the ConfigMap"
  grep -A1 -E '^        - name: DEBUG_JOB_IMAGE_TAG$' <<<"$out" | grep -q 'value: "1.2.0"' \
    && pass "DEBUG_JOB_IMAGE_TAG from jobImage.tag" || fail "DEBUG_JOB_IMAGE_TAG from jobImage.tag"
  # The 1.x-era name, renamed in story 8.1 (spelled so a repository grep finds no use of it).
  contains "$out" 'DEBUG_IT_JOB_IMAGE_TA[G]' && fail "old image tag env name gone" || pass "old image tag env name gone"
  # Story 8.1: an empty or absent jobImage.tag means the Debug Job image of
  # the same release, debug-job-v<chart appVersion>.
  app_version="$(sed -n 's/^appVersion: *//p' "$chart/Chart.yaml" | tr -d "\"' ")"
  for tag_arg in 'debugIt.jobImage.tag=' 'debugIt.jobImage.tag=null'; do
    if tag_out="$(render_on --set "$tag_arg")"; then
      grep -A1 -E '^        - name: DEBUG_JOB_IMAGE_TAG$' <<<"$tag_out" | grep -qF "value: \"debug-job-v$app_version\"" \
        && pass "DEBUG_JOB_IMAGE_TAG default with --set $tag_arg" \
        || fail "DEBUG_JOB_IMAGE_TAG default with --set $tag_arg" "$(grep -A1 'DEBUG_JOB_IMAGE_TAG' <<<"$tag_out")"
    else
      fail "DEBUG_JOB_IMAGE_TAG default with --set $tag_arg (render failed)" "$tag_out"
    fi
  done
  grep -A1 -E '^        - name: DEBUG_IT_RESULTS_PORT$' <<<"$out" | grep -q 'value: "3002"' \
    && pass "DEBUG_IT_RESULTS_PORT" || fail "DEBUG_IT_RESULTS_PORT"
  cm="$(doc "$out" ConfigMap debug-it-job-template)"
  job_line="$(grep -E '^  job.json: ' <<<"$cm" | sed 's/^  job.json: //')"
  if job="$(python3 -c 'import json,sys; print(json.dumps(json.loads(json.loads(sys.stdin.read())), sort_keys=True))' <<<"$job_line")"; then
    pass "job.json is JSON"
  else
    fail "job.json is JSON" "$cm"
  fi
  for fragment in '"backoffLimit": 0' '"automountServiceAccountToken": false' '"readOnlyRootFilesystem": true' \
    '"ttlSecondsAfterFinished": 300' '"restartPolicy": "Never"' '"runAsNonRoot": true' '"drop": ["ALL"]' \
    '"sizeLimit": "768Mi"' '"namespace": "debug-it"' '"image": "acme/debug-job"' \
    '"value": "http://backend.default.svc.cluster.local:3002"'; do
    grep -qF -- "$fragment" <<<"$job" && pass "job.json has $fragment" || fail "job.json has $fragment"
  done
  python3 - "$job" "$root/code/backend/tests/fixtures/debug-job-template.json" <<'PY' && pass "job.json containers and mounts" || fail "job.json containers and mounts"
import json, sys
rendered = json.loads(sys.argv[1])
with open(sys.argv[2]) as f:
    assert rendered == json.load(f), "job.json differs from the backend test fixture"
spec = rendered["spec"]["template"]["spec"]
init = spec["initContainers"]
assert [c["name"] for c in init] == ["receiver", "key-helper"], init
assert "restartPolicy" not in init[0] and init[1]["restartPolicy"] == "Always"
assert [c["name"] for c in spec["containers"]] == ["claude"]
mounts = {c["name"]: {m["name"] for m in c["volumeMounts"]} for c in init + spec["containers"]}
assert mounts == {"receiver": {"work", "upload-code"}, "key-helper": {"anthropic-key"},
                  "claude": {"work", "wrapper", "result-code"}}, mounts
secrets = {v["name"]: v["secret"] for v in spec["volumes"] if "secret" in v}
assert set(secrets) == {"anthropic-key", "upload-code", "result-code"}
assert all(s["secretName"] == "" and s["defaultMode"] == 288 for s in secrets.values())
assert {n: [i["key"] for i in s["items"]] for n, s in secrets.items()} == {
    "anthropic-key": ["anthropic-api-key"], "upload-code": ["upload-code"], "result-code": ["result-code"]}
PY
  grep -A4 -E '^        - name: DEBUG_IT_CHECK_JOB_TEMPLATE$' <<<"$out" | grep -q 'key: check-job.json' \
    && pass "DEBUG_IT_CHECK_JOB_TEMPLATE from the ConfigMap" || fail "DEBUG_IT_CHECK_JOB_TEMPLATE from the ConfigMap"
  check_line="$(grep -E '^  check-job.json: ' <<<"$cm" | sed 's/^  check-job.json: //')"
  if check="$(python3 -c 'import json,sys; print(json.dumps(json.loads(json.loads(sys.stdin.read())), sort_keys=True))' <<<"$check_line")"; then
    pass "check-job.json is JSON"
  else
    fail "check-job.json is JSON" "$cm"
  fi
  for fragment in '"backoffLimit": 0' '"activeDeadlineSeconds": 120' '"ttlSecondsAfterFinished": 300' \
    '"automountServiceAccountToken": false' '"enableServiceLinks": false' '"restartPolicy": "Never"' \
    '"readOnlyRootFilesystem": true' '"runAsNonRoot": true' '"drop": ["ALL"]' '"namespace": "debug-it"' \
    '"image": "acme/debug-job"' '"debug-it/check": "true"' '"command": ["node", "/app/src/isolationCheck.ts"]' \
    '"value": "http://backend.default.svc.cluster.local:3002"'; do
    grep -qF -- "$fragment" <<<"$check" && pass "check-job.json has $fragment" || fail "check-job.json has $fragment"
  done
  python3 - "$check" "$job" "$root/code/backend/tests/fixtures/debug-check-job-template.json" <<'PY' && pass "check-job.json matches the Debug Job" || fail "check-job.json matches the Debug Job"
import json, sys
check = json.loads(sys.argv[1])
job = json.loads(sys.argv[2])
with open(sys.argv[3]) as f:
    assert check == json.load(f), "check-job.json differs from the backend test fixture"
spec = check["spec"]["template"]["spec"]
run = job["spec"]["template"]["spec"]
assert [c["name"] for c in spec["containers"]] == ["isolation-check"]
assert "initContainers" not in spec and "volumes" not in spec
container = spec["containers"][0]
assert "volumeMounts" not in container and "envFrom" not in container
claude = run["containers"][0]
assert container["securityContext"] == claude["securityContext"]
assert spec["securityContext"] == run["securityContext"]
claude_env = {e["name"]: e["value"] for e in claude["env"]}
assert container["env"] == [{"name": n, "value": claude_env[n]} for n in ("RESULTS_URL", "BACKEND_MAIN_PORT")]
labels = dict(job["metadata"]["labels"], **{"debug-it/check": "true"})
assert check["metadata"]["labels"] == labels and check["spec"]["template"]["metadata"]["labels"] == labels
assert container["image"] == claude["image"]
PY
  contains "$out" '^kind: Secret' && fail "still no kind: Secret" || pass "still no kind: Secret"
else
  fail "renders with every required value" "$out"
fi

echo "# On, serviceAccount.enabled: that ServiceAccount is bound, none rendered"
if out="$(render_on --set serviceAccount.enabled=true --set serviceAccount.name=acme-backend)"; then
  binding="$(doc "$out" RoleBinding debug-it-backend)"
  contains "$binding" '^  name: acme-backend$' && pass "binds serviceAccount.name" || fail "binds serviceAccount.name" "$binding"
  [ -z "$(doc "$out" ServiceAccount backend-debug-it)" ] && pass "no extra ServiceAccount" || fail "no extra ServiceAccount"
  contains "$out" '^      serviceAccountName: acme-backend$' && pass "Deployment keeps serviceAccount.name" \
    || fail "Deployment keeps serviceAccount.name"
else
  fail "serviceAccount.enabled renders" "$out"
fi

echo "# On, a custom debug namespace"
if out="$(render_on --set debugIt.debugNamespace=acme-debug)"; then
  [ "$(grep -cE '^  namespace: acme-debug$' <<<"$out")" -eq 3 ] && pass "Role, RoleBinding and policy in debugNamespace" \
    || fail "Role, RoleBinding and policy in debugNamespace" "$(grep -E 'namespace:' <<<"$out")"
else
  fail "custom debug namespace renders" "$out"
fi

echo "# On, network values missing: the defaults apply"
if out="$(render_on --set debugIt.network=null --set debugIt.resultsPort=null)"; then
  jobnp="$(doc "$out" NetworkPolicy debug-it-job)"
  contains "$jobnp" 'cidr: "160.79.104.0/23"' && contains "$jobnp" 'k8s-app: kube-dns$' && contains "$jobnp" '^      port: 3002$' \
    && pass "network and results port defaults" || fail "network and results port defaults" "$jobnp"
else
  fail "renders without network values" "$out"
fi

echo "# On, a required value missing: rendering fails naming it"
expect_render_fails "jobImage.repository"       "debugIt.jobImage.repository" --set debugIt.jobImage.repository=
expect_render_fails "jobImage.tag not a tag"    "debugIt.jobImage.tag" --set 'debugIt.jobImage.tag=latest:evil'
fs_token='[{"envName":"GITHUB_TOKEN","secretName":"github-runner-monitor-token","secretKey":"token"}]'
expect_render_fails "S3 bucket"                 "JOB_STATE_S3_BUCKET"   --set deployment.env.regular.JOB_STATE_S3_BUCKET=
expect_render_fails "webhook secret"            "GITHUB_WEBHOOK_SECRET" --set-json "deployment.env.fromSecrets=$fs_token"
expect_render_fails "githubApp.appId"           "debugIt.githubApp.appId" --set debugIt.githubApp.appId=
expect_render_fails "githubApp.privateKeySecret" "debugIt.githubApp.privateKeySecret" --set debugIt.githubApp.privateKeySecret=null
expect_render_fails "githubApp.privateKeySecret.key" "debugIt.githubApp.privateKeySecret.key" --set debugIt.githubApp.privateKeySecret.key=
expect_render_fails "githubApp.clientId"        "debugIt.githubApp.clientId" --set debugIt.githubApp.clientId=
expect_render_fails "githubApp.clientSecretSecret" "debugIt.githubApp.clientSecretSecret" --set debugIt.githubApp.clientSecretSecret.name=
expect_render_fails "administrators"            "debugIt.administrators" --set-json 'debugIt.administrators=[]'
expect_render_fails "publicUrl"                 "debugIt.publicUrl"     --set debugIt.publicUrl=
expect_render_fails "encryptionSecret"          "debugIt.encryptionSecret" --set debugIt.encryptionSecret.name=
expect_render_fails "anthropicApiKeySecret (organization mode)" "debugIt.anthropicApiKeySecret" --set debugIt.anthropicApiKeySecret=null

echo "# On, personal mode without an Anthropic reference"
if out="$(render_on --set debugIt.credentialsMode=personal --set debugIt.anthropicApiKeySecret=null)"; then
  pass "personal mode renders"
  contains "$out" 'DEBUG_IT_ANTHROPIC_API_KEY' && fail "no Anthropic env in personal mode" || pass "no Anthropic env in personal mode"
else
  fail "personal mode renders" "$out"
fi

echo "# On, replicasCount above 1 is still forced to one pod"
if out="$(render_on --set deployment.replicasCount=3)"; then
  contains "$out" '^  replicas: 1$' && ! contains "$out" 'replicas: 3' && pass "replicasCount 3 renders replicas 1" || fail "replicasCount 3 renders replicas 1"
else
  fail "replicasCount 3 renders" "$out"
fi

echo "# On, personal mode with an Anthropic reference whose name is empty"
if out="$(render_on --set debugIt.credentialsMode=personal --set debugIt.anthropicApiKeySecret.name=)"; then
  pass "empty optional reference counts as unset"
else
  fail "empty optional reference counts as unset" "$out"
fi

echo "# On, a list given as a string"
expect_render_fails "allowedUsers as string" "debugIt.allowedUsers must be a list" --set debugIt.allowedUsers=1000003

echo "# On, a login where a GitHub user ID belongs"
expect_render_fails "administrator as login" "numeric user IDs" --set-json 'debugIt.administrators=["acme-admin"]'
expect_render_fails "allowed user as login"  "numeric user IDs" --set-json 'debugIt.allowedUsers=["acme-dev"]'

echo "# On, autoscaling"
expect_render_fails "autoscaling on" "autoscaling" --set deployment.autoscaling.enabled=true

echo "# On, a secret given as a plain string"
expect_render_fails "anthropicApiKeySecret as string" "must be a Secret reference" --set debugIt.anthropicApiKeySecret=abc
expect_render_fails "privateKeySecret as string"      "must be a Secret reference" --set debugIt.githubApp.privateKeySecret=abc
expect_render_fails "clientSecretSecret as string"    "must be a Secret reference" --set debugIt.githubApp.clientSecretSecret=abc
expect_render_fails "encryptionSecret as string"      "must be a Secret reference" --set debugIt.encryptionSecret=abc
expect_render_fails "personal mode, string still refused" "must be a Secret reference" \
  --set debugIt.credentialsMode=personal --set debugIt.anthropicApiKeySecret=abc


echo "# On, story 6.1: cost telemetry"
if out="$(render_on)"; then
  grep -A1 -E '^        - name: DEBUG_IT_COST_TELEMETRY_ENABLED$' <<<"$out" | grep -q 'value: "false"' \
    && pass "cost telemetry off by default" || fail "cost telemetry off by default"
  contains "$out" 'DEBUG_IT_COST_TELEMETRY_API_KEY' && fail "no collector key env without a reference" \
    || pass "no collector key env without a reference"
else
  fail "renders with cost telemetry off" "$out"
fi
telemetry_on=(--set debugIt.costTelemetry.enabled=true
  --set debugIt.costTelemetry.endpoint=http://otel-collector.monitoring:4318
  --set debugIt.costTelemetry.apiKeySecret.name=acme-otel --set debugIt.costTelemetry.apiKeySecret.key=apiKey)
if out="$(render_on "${telemetry_on[@]}")"; then
  grep -A1 -E '^        - name: DEBUG_IT_COST_TELEMETRY_ENABLED$' <<<"$out" | grep -q 'value: "true"' \
    && pass "cost telemetry on" || fail "cost telemetry on"
  grep -A1 -E '^        - name: DEBUG_IT_COST_TELEMETRY_ENDPOINT$' <<<"$out" \
    | grep -q 'value: "http://otel-collector.monitoring:4318"' \
    && pass "cost telemetry endpoint" || fail "cost telemetry endpoint"
  key_env="$(grep -A4 -E '^        - name: DEBUG_IT_COST_TELEMETRY_API_KEY$' <<<"$out")"
  grep -q 'secretKeyRef:' <<<"$key_env" && grep -q 'name: "acme-otel"' <<<"$key_env" && grep -q 'key: "apiKey"' <<<"$key_env" \
    && pass "DEBUG_IT_COST_TELEMETRY_API_KEY only as secretKeyRef" || fail "DEBUG_IT_COST_TELEMETRY_API_KEY only as secretKeyRef" "$key_env"
  contains "$out" '^kind: Secret' && fail "telemetry on: no kind: Secret" || pass "telemetry on: no kind: Secret"
  base="$(render_on)"
  [ "$(doc "$base" NetworkPolicy debug-it-job)" == "$(doc "$out" NetworkPolicy debug-it-job)" ] \
    && [ "$(doc "$base" ConfigMap debug-it-job-template)" == "$(doc "$out" ConfigMap debug-it-job-template)" ] \
    && pass "telemetry on: Debug Job template and NetworkPolicy unchanged" \
    || fail "telemetry on: Debug Job template and NetworkPolicy unchanged"
else
  fail "renders with cost telemetry on" "$out"
fi
expect_render_fails "telemetry on without endpoint" "debugIt.costTelemetry.endpoint" \
  --set debugIt.costTelemetry.enabled=true
expect_render_fails "telemetry endpoint not a URL" "debugIt.costTelemetry.endpoint must start with" \
  --set debugIt.costTelemetry.enabled=true --set debugIt.costTelemetry.endpoint=otel-collector:4318
expect_render_fails "collector key as string" "must be a Secret reference" \
  --set debugIt.costTelemetry.apiKeySecret=abc
expect_render_fails "collector key reference without key" "debugIt.costTelemetry.apiKeySecret.key" \
  --set debugIt.costTelemetry.apiKeySecret.name=acme-otel

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
