#!/usr/bin/env bash
# Story 7.4: leak sweep and dashboard attack tests (SR12, SR13, SR15, SR16,
# and SR6/SR10 across this job). Runs in the Story 7.1 kind cluster with
# Calico (see .github/workflows/attack-tests.yml, job "leak"):
#
#   1. checks the four secrets it reuses (no new secret);
#   2. installs the chart with Debug it on (install_chart, lib.sh);
#   3. installs MinIO (namespace attack-s3, image pinned by digest) and
#      creates the bucket;
#   4. creates the test Secrets and ConfigMaps: the harness, the 7.2 key
#      helper, its own OAuth token Secret and the patched job template;
#   5. scales the chart backend to 0 and starts the test pod attack-backend
#      from the backend image, with the backend's labels and service account
#      and a /work emptyDir, running leak-backend.ts;
#   6. installs the frontend release (frontend:attack-test, nginx with its CSP);
#   7. keeps every Debug Job pod's container logs in files as pods appear;
#   8. waits for "attack: browser-ready", port-forwards svc/frontend and runs
#      browser-attack.mjs (Playwright, Chromium), then touches /work/browser-done;
#   9. waits for the harness to exit, copies /work out and runs leak-sweep.mjs
#      over it, the pod log, the Debug Job logs and the browser output;
#  10. prints diagnostics on FAIL (finish), without any log text.
#
#   CLAUDE_CODE_OAUTH_TOKEN=... ATTACK_TEST_GITHUB_APP_ID=... \
#   ATTACK_TEST_GITHUB_APP_PRIVATE_KEY=... ATTACK_TEST_REPO=owner/name \
#   bash helm/tests/attack/leak-attack-test.sh
#
# Expects what agent-attack-test.sh expects (kubectl on the cluster with the
# backend, Debug Job and frontend images loaded, helm 3, node 24, jq) plus
# npm ci in code/backend (mint-cookie) and in helm/tests/attack/browser with
# Chromium installed for Playwright.
#
# Every other value (session and encryption keys, webhook secret, telemetry
# key, fake organization and personal Anthropic keys, MinIO credentials) is
# generated here, travels only in files and Kubernetes Secrets and is never
# printed. Prints ok/FAIL/warn lines; any FAIL exits 1.
set -uo pipefail

for name in CLAUDE_CODE_OAUTH_TOKEN ATTACK_TEST_GITHUB_APP_ID ATTACK_TEST_GITHUB_APP_PRIVATE_KEY ATTACK_TEST_REPO; do
  value="${!name:-}"
  if [ -z "${value//[[:space:]]/}" ]; then
    echo "FAIL - $name is not set"
    exit 1
  fi
done
repo="$(printf '%s' "$ATTACK_TEST_REPO" | tr -d '[:space:]')"
if ! [[ "$repo" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]]; then
  echo "FAIL - ATTACK_TEST_REPO is not owner/name"
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helm/tests/attack/lib.sh
. "$here/lib.sh"

# The logs may hold a leaked value: diagnostics never print them.
DIAGNOSTIC_LOGS=0
S3_NS="attack-s3"
FRONTEND_RELEASE="runner-monitor-frontend"
MINIO_IMAGE="pgsty/minio:RELEASE.2026-06-18T00-00-00Z@sha256:dacff8306a6e0a734518533992dbdcca26bc1ca47f77cf47cb9945725f92b29b"
BUCKET="debug-it-attack-leak"
POD="attack-backend"
FRONTEND_PORT="${FRONTEND_PORT:-18080}"
READY_WAIT_SECONDS=2400 # setup, the authorization and key checks, the 15 min full run, the hostile run
END_WAIT_SECONDS=600

secrets="$work/secrets"
out="$work/out"
mkdir -p "$secrets" "$out/jobs"
chmod 700 "$secrets"

bg_pids=()
stop_background() {
  local pid
  for pid in "${bg_pids[@]}"; do kill "$pid" 2>/dev/null; done
  return 0
}
trap 'stop_background; rm -rf "$work"' EXIT

# ---- 1. Secrets and generated values (files only, never arguments) ---------
random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
put() { printf '%s' "$2" >"$secrets/$1"; }
put ATTACK_TEST_GITHUB_APP_ID "$(printf '%s' "$ATTACK_TEST_GITHUB_APP_ID" | tr -d '[:space:]')"
put ATTACK_TEST_GITHUB_APP_PRIVATE_KEY "$ATTACK_TEST_GITHUB_APP_PRIVATE_KEY"
put ATTACK_TEST_REPO "$repo"
put oauth-token "$(printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" | tr -d '[:space:]')"
put ATTACK_SESSION_KEY "$(random_hex 32)"
put ATTACK_PERSONAL_KEY_ENCRYPTION_KEY "$(random_hex 32)"
put ATTACK_WEBHOOK_SECRET "attack-webhook-$(random_hex 20)"
put ATTACK_TELEMETRY_API_KEY "attack-telemetry-$(random_hex 20)"
put ATTACK_ORG_KEY "sk-ant-api03-attack-organization-$(random_hex 24)"
put ATTACK_PERSONAL_KEY "sk-ant-api03-attack-personal-$(random_hex 24)"
put ATTACK_S3_ACCESS_KEY "attack$(random_hex 8)"
put ATTACK_S3_SECRET_KEY "$(random_hex 24)"
put ATTACK_S3_ENDPOINT "http://minio.$S3_NS.svc.cluster.local:9000"
put ATTACK_S3_BUCKET "$BUCKET"
pass "secrets set, test values generated"

if [ -d "$root/code/backend/node_modules/tsx" ]; then
  pass "backend dependencies installed (mint-cookie)"
else
  fail "backend dependencies installed (run npm ci in code/backend)"
  finish
fi
if [ -d "$here/browser/node_modules/playwright" ]; then
  pass "browser test dependencies installed"
else
  fail "browser test dependencies installed (run npm ci in helm/tests/attack/browser)"
  finish
fi

# ---- 2. The chart ----------------------------------------------------------
install_chart

# ---- 3. MinIO --------------------------------------------------------------
echo "# Setup: MinIO in $S3_NS"
setup_or_die "namespace $S3_NS" "$KUBECTL" create namespace "$S3_NS"
setup_or_die "MinIO root Secret" "$KUBECTL" create secret generic minio-root -n "$S3_NS" \
  --from-file=MINIO_ROOT_USER="$secrets/ATTACK_S3_ACCESS_KEY" --from-file=MINIO_ROOT_PASSWORD="$secrets/ATTACK_S3_SECRET_KEY"
cat >"$work/minio.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: $S3_NS
spec:
  replicas: 1
  selector:
    matchLabels: {app: attack-minio}
  template:
    metadata:
      labels: {app: attack-minio}
    spec:
      containers:
      - name: minio
        image: $MINIO_IMAGE
        args: [server, /data, --address, ":9000"]
        envFrom:
        - secretRef: {name: minio-root}
        ports:
        - {containerPort: 9000, name: s3}
        readinessProbe:
          httpGet: {path: /minio/health/ready, port: 9000}
          periodSeconds: 3
        volumeMounts:
        - {name: data, mountPath: /data}
      volumes:
      - name: data
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: $S3_NS
spec:
  selector: {app: attack-minio}
  ports:
  - {name: s3, port: 9000, targetPort: 9000}
EOF
setup_or_die "MinIO Deployment and Service" "$KUBECTL" apply -f "$work/minio.yaml"
setup_or_die "MinIO ready" "$KUBECTL" rollout status deployment/minio -n "$S3_NS" --timeout=300s
# The bucket, with the backend image's own S3 SDK (credentials from the Secret).
cat >"$work/bucket.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: attack-s3-bucket
  namespace: $S3_NS
spec:
  restartPolicy: Never
  containers:
  - name: bucket
    image: backend:attack-test
    imagePullPolicy: Never
    workingDir: /app
    envFrom:
    - secretRef: {name: minio-root}
    env:
    - {name: BUCKET, value: $BUCKET}
    command:
    - node
    - -e
    - |
      const s3 = require('/app/node_modules/@aws-sdk/client-s3');
      const client = new s3.S3Client({ region: 'us-east-1', endpoint: 'http://minio.$S3_NS.svc.cluster.local:9000', forcePathStyle: true,
        credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD } });
      // Versioning on, so the dump also sees deleted and overwritten versions.
      client.send(new s3.CreateBucketCommand({ Bucket: process.env.BUCKET }))
        .then(() => client.send(new s3.PutBucketVersioningCommand({ Bucket: process.env.BUCKET, VersioningConfiguration: { Status: 'Enabled' } })))
        .then(
          () => console.log('bucket created, versioning on'),
          (e) => { console.log('bucket not created or versioning not on: ' + e.name); process.exit(1); });
EOF
setup_or_die "bucket Pod" "$KUBECTL" apply -f "$work/bucket.yaml"
if wait_for attack-s3-bucket "$S3_NS" '{.status.phase}' '^(Succeeded|Failed)$' 180 >/dev/null \
  && [ "$(k get pod attack-s3-bucket -n "$S3_NS" -o jsonpath='{.status.phase}')" == Succeeded ]; then
  pass "bucket $BUCKET created, versioning on"
else
  fail "bucket $BUCKET created, versioning on" "$(k logs attack-s3-bucket -n "$S3_NS" 2>&1 | tail -n 5)"
  finish
fi

# ---- 4. Test Secrets and ConfigMaps ----------------------------------------
echo "# Setup: harness, key helper, OAuth token Secret, patched job template"
# package.json marks /attack as ES modules: without it tsx compiles the
# harness as CommonJS and refuses its top-level await.
setup_or_die "harness ConfigMap" "$KUBECTL" create configmap attack-leak-harness -n "$NS" \
  --from-file=leak-backend.ts="$here/leak-backend.ts" --from-file=github-write-attack.ts="$here/github-write-attack.ts" \
  --from-file=leak-sweep.mjs="$here/leak-sweep.mjs" --from-literal=package.json='{"type":"module"}'
setup_or_die "oauth key helper ConfigMap" "$KUBECTL" create configmap attack-oauth-helper -n "$DEBUG_NS" \
  --from-file=oauth-key-helper.mjs="$here/oauth-key-helper.mjs"
setup_or_die "OAuth token Secret (read only by the key helper)" "$KUBECTL" create secret generic attack-oauth-token -n "$DEBUG_NS" \
  --from-file=token="$secrets/oauth-token"
env_args=()
for name in ATTACK_TEST_GITHUB_APP_ID ATTACK_TEST_GITHUB_APP_PRIVATE_KEY ATTACK_TEST_REPO ATTACK_SESSION_KEY \
  ATTACK_PERSONAL_KEY_ENCRYPTION_KEY ATTACK_WEBHOOK_SECRET ATTACK_TELEMETRY_API_KEY ATTACK_ORG_KEY ATTACK_PERSONAL_KEY \
  ATTACK_S3_ACCESS_KEY ATTACK_S3_SECRET_KEY ATTACK_S3_ENDPOINT ATTACK_S3_BUCKET; do
  env_args+=("--from-file=$name=$secrets/$name")
done
setup_or_die "harness environment Secret" "$KUBECTL" create secret generic attack-leak-env -n "$NS" "${env_args[@]}"

template="$(job_template)"
[ -n "$template" ] && pass "job template read back from the installed ConfigMap" || { fail "job template read back"; finish; }
# The 7.2 key-helper swap, on the template the harness's Kubernetes adapter
# uses: the helper runs oauth-key-helper.mjs and reads the OAuth token from
# its own Secret (ANTHROPIC_KEY_FILE); the per-run Secret still holds the
# fake organization key. RESULTS_URL stays as rendered: the real Debug Job
# posts to the backend Service on 3002, which is the test pod. The helper's
# own result sink (RESULT_CODE, RUN_ID) is unused. The Job outlives its end
# so the logs can be read.
TEMPLATE_FILTER='
  .spec.ttlSecondsAfterFinished = 3600
  | .spec.template.spec.initContainers |= map(
      if .name == "key-helper" then
        .command = ["node", "/attack/oauth-key-helper.mjs"]
        | .env = ((.env // []) + [
            {name: "ANTHROPIC_KEY_FILE", value: "/attack-token/token"},
            {name: "RESULT_CODE", value: "unused-the-claude-container-posts-to-the-backend"},
            {name: "RUN_ID", value: "unused"},
            {name: "SINK_PORT", value: "8090"}])
        | .volumeMounts = ((.volumeMounts // []) + [
            {name: "attack-helper", mountPath: "/attack", readOnly: true},
            {name: "attack-token", mountPath: "/attack-token", readOnly: true}])
      else . end)
  | .spec.template.spec.volumes += [
      {name: "attack-helper", configMap: {name: "attack-oauth-helper"}},
      {name: "attack-token", secret: {secretName: "attack-oauth-token", defaultMode: 288}}]'
if jq -c "$TEMPLATE_FILTER" <<<"$template" >"$work/job.json" 2>"$work/jq.err"; then
  pass "job template patched (key helper as in 7.2, its own token Secret)"
else
  fail "job template patched" "$(cat "$work/jq.err")"
  finish
fi
setup_or_die "patched job template ConfigMap" "$KUBECTL" create configmap attack-job-template -n "$NS" --from-file=job.json="$work/job.json"

# ---- 5. The test pod in place of the backend --------------------------------
echo "# Setup: backend scaled to 0, test pod $POD"
setup_or_die "chart backend scaled to 0" "$KUBECTL" scale deployment/backend -n "$NS" --replicas=0
for ((i = 0; i < 120; i += 2)); do
  [ -z "$(k get pods -n "$NS" -l "$BACKEND_LABEL" -o name 2>/dev/null)" ] && break
  sleep 2
done
# The Deployment's own pod template: same image, labels, service account and
# security context; only the command, env, ports, volumes and probes differ.
if k get deployment backend -n "$NS" -o json | jq --arg ns "$NS" --arg tag "$JOB_IMAGE_TAG" --arg dns "$DEBUG_NS" '
  {apiVersion: "v1", kind: "Pod",
   metadata: {name: "attack-backend", namespace: $ns, labels: .spec.template.metadata.labels},
   spec: (.spec.template.spec
     | .restartPolicy = "Never"
     | .containers = [.containers[0]
         | del(.readinessProbe, .livenessProbe, .startupProbe, .args, .envFrom)
         | .name = "attack-backend"
         | .workingDir = "/app"
         | .command = ["sh", "-c", "cd /app && npx tsx /attack/leak-backend.ts; echo $? > /work/exit-code; while [ ! -f /work/copied ]; do sleep 2; done"]
         | .env = [
             {name: "NODE_ENV", value: "production"},
             {name: "ATTACK_WORK", value: "/work"},
             {name: "ATTACK_BACKEND_DIR", value: "/app"},
             {name: "DEBUG_IT_NAMESPACE", value: $dns},
             {name: "DEBUG_JOB_IMAGE_TAG", value: $tag},
             {name: "DEBUG_IT_JOB_TEMPLATE", valueFrom: {configMapKeyRef: {name: "attack-job-template", key: "job.json"}}}]
         | .envFrom = [{secretRef: {name: "attack-leak-env"}}]
         | .ports = [{name: "http", containerPort: 3001, protocol: "TCP"}, {name: "results", containerPort: 3002, protocol: "TCP"}]
         | .volumeMounts = [{name: "attack-harness", mountPath: "/attack", readOnly: true}, {name: "attack-work", mountPath: "/work"}]]
     | .volumes = [{name: "attack-harness", configMap: {name: "attack-leak-harness"}}, {name: "attack-work", emptyDir: {}}])}' \
  >"$work/pod.json" 2>"$work/jq.err"; then
  pass "test pod built from the backend Deployment's pod template"
else
  fail "test pod built from the backend Deployment's pod template" "$(cat "$work/jq.err")"
  finish
fi
setup_or_die "test pod $POD created" "$KUBECTL" create -f "$work/pod.json"
if out_wait="$(wait_for "$POD" "$NS" '{.status.phase}' '^(Running|Succeeded|Failed)$' 300)"; then
  phase="$(k get pod "$POD" -n "$NS" -o jsonpath='{.status.phase}')"
  if [ "$phase" != Running ]; then
    fail "test pod $POD running" "phase: $phase"
    finish
  fi
  pass "test pod $POD running"
else
  fail "test pod $POD running" "$out_wait"
  finish
fi
# The harness lines, live in the job log (they are redacted in the pod).
k logs -f "$POD" -n "$NS" >"$out/pod-follow.log" 2>&1 &
bg_pids+=($!)
tail -n +1 -f "$out/pod-follow.log" 2>/dev/null &
bg_pids+=($!)

# ---- 6. The frontend ----------------------------------------------------------
echo "# Setup: frontend release (nginx with its CSP)"
setup_or_die "helm install frontend" "$HELM" install "$FRONTEND_RELEASE" "$chart" --namespace "$NS" \
  -f "$root/helm/values-frontend.yaml" --set deployment.image.name=frontend --set deployment.image.tag=attack-test \
  --wait --timeout 5m

# ---- 7. Debug Job pod logs, kept as pods appear --------------------------------
# One file per pod, every container, refreshed while the pod exists; the
# harness holds the Job deletes back until the browser test is done.
snapshot_job_logs() {
  local pod name
  for pod in $(k get pods -n "$DEBUG_NS" -l 'app.kubernetes.io/name=debug-it-job' -o name 2>/dev/null); do
    name="${pod#pod/}"
    if k logs -n "$DEBUG_NS" "$name" --all-containers --prefix >"$out/jobs/$name.tmp" 2>/dev/null && [ -s "$out/jobs/$name.tmp" ]; then
      mv "$out/jobs/$name.tmp" "$out/jobs/$name.log"
    else
      rm -f "$out/jobs/$name.tmp"
    fi
  done
}
(while true; do snapshot_job_logs; sleep 10; done) &
bg_pids+=($!)

# ---- 8. The browser test ------------------------------------------------------
echo "# Wait for the harness: authorization, personal key, full run, hostile run"
ready=""
for ((i = 0; i < READY_WAIT_SECONDS; i += 5)); do
  ready="$(sed -n 's/^attack: browser-ready //p' "$out/pod-follow.log" | tail -n 1)"
  [ -n "$ready" ] && break
  [ -n "$(k exec "$POD" -n "$NS" -- cat /work/exit-code 2>/dev/null)" ] && break
  sleep 5
done
run_id="$(tr ' ' '\n' <<<"$ready" | sed -n 's/^run=//p')"
job_id="$(tr ' ' '\n' <<<"$ready" | sed -n 's/^job=//p')"
if [[ "$run_id" =~ ^[0-9a-f-]{36}$ ]] && [[ "$job_id" =~ ^[0-9]+$ ]]; then
  pass "harness ready for the browser test"
  "$KUBECTL" port-forward -n "$NS" "svc/frontend" "$FRONTEND_PORT:80" >"$work/port-forward.log" 2>&1 &
  bg_pids+=($!)
  for ((i = 0; i < 60; i += 1)); do
    curl -fsS -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/" 2>/dev/null && break
    sleep 1
  done
  if ATTACK_SESSION_KEY="$(cat "$secrets/ATTACK_SESSION_KEY")" "$NODE" "$here/leak-backend.ts" mint-cookie \
    >"$secrets/browser-cookie.json" 2>"$work/mint.err"; then
    pass "dana's session cookie minted for the browser"
    ATTACK_BASE_URL="http://127.0.0.1:$FRONTEND_PORT" ATTACK_COOKIE_FILE="$secrets/browser-cookie.json" \
      ATTACK_RUN="$run_id" ATTACK_JOB="$job_id" ATTACK_REPO="$repo" ATTACK_OUT="$out" \
      "$NODE" "$here/browser-attack.mjs" >"$work/browser.log" 2>&1
    cat "$work/browser.log"
    browser_fails="$(grep -c '^FAIL' "$work/browser.log")"
    if [ "$browser_fails" == 0 ] && grep -q '^browser attack test: all ok' "$work/browser.log"; then
      pass "browser attack test (SR16)"
    else
      fail "browser attack test (SR16): $browser_fails FAIL lines"
    fi
  else
    fail "dana's session cookie minted for the browser" "$(tail -n 3 "$work/mint.err")"
  fi
else
  fail "harness ready for the browser test (no browser-ready line within ${READY_WAIT_SECONDS}s)"
fi
snapshot_job_logs
job_logs=("$out"/jobs/*.log)
if [ -e "${job_logs[0]}" ]; then
  pass "Debug Job logs collected (${#job_logs[@]} pods)"
else
  fail "Debug Job logs collected (no Debug Job pod)"
fi
k exec "$POD" -n "$NS" -- touch /work/browser-done >/dev/null 2>&1

# ---- 9. The harness's end, /work and the sweep -----------------------------------
exit_code=""
for ((i = 0; i < END_WAIT_SECONDS; i += 3)); do
  exit_code="$(k exec "$POD" -n "$NS" -- cat /work/exit-code 2>/dev/null | tr -d '[:space:]')"
  [ -n "$exit_code" ] && break
  sleep 3
done
mkdir -p "$out/work"
if [ -n "$exit_code" ] && k exec "$POD" -n "$NS" -- tar cf - -C /work . 2>"$work/cp.log" | tar xf - -C "$out/work" 2>>"$work/cp.log" \
  && [ -e "$out/work/values.json" ]; then
  pass "harness ended, /work copied out"
else
  fail "harness ended, /work copied out" "exit code: ${exit_code:-none}; $(tail -n 2 "$work/cp.log" 2>/dev/null)"
fi
k exec "$POD" -n "$NS" -- touch /work/copied >/dev/null 2>&1
k logs "$POD" -n "$NS" >"$out/pod.log" 2>&1
sleep 3 # the live log catches up
stop_background
bg_pids=()
harness_fails="$(grep -c '^FAIL' "$out/pod.log")"
if [ "$exit_code" == 0 ] && [ "$harness_fails" == 0 ] && grep -q '^leak backend: all ok' "$out/pod.log"; then
  pass "leak-backend.ts: authorization, personal key, full run, hostile run, GitHub writes and tokens, audit"
else
  fail "leak-backend.ts: exit code ${exit_code:-none}, $harness_fails FAIL lines (above)"
fi

echo "# Leak sweep (SR12)"
# The runner's own known values, added to the harness's.
jq -n --rawfile oauth "$secrets/oauth-token" --rawfile key "$secrets/ATTACK_TEST_GITHUB_APP_PRIVATE_KEY" \
  --rawfile session "$secrets/ATTACK_SESSION_KEY" --rawfile personal "$secrets/ATTACK_PERSONAL_KEY_ENCRYPTION_KEY" \
  --rawfile webhook "$secrets/ATTACK_WEBHOOK_SECRET" --rawfile telemetry "$secrets/ATTACK_TELEMETRY_API_KEY" \
  --rawfile org "$secrets/ATTACK_ORG_KEY" --rawfile pkey "$secrets/ATTACK_PERSONAL_KEY" \
  --rawfile s3a "$secrets/ATTACK_S3_ACCESS_KEY" --rawfile s3s "$secrets/ATTACK_S3_SECRET_KEY" \
  --slurpfile browser <(cat "$secrets/browser-cookie.json" 2>/dev/null || echo '{}') '
  [{name: "oauth-token", value: $oauth}, {name: "github-app-private-key", value: $key},
   {name: "session-key", value: $session}, {name: "personal-key-encryption-key", value: $personal},
   {name: "webhook-secret", value: $webhook}, {name: "telemetry-api-key", value: $telemetry},
   {name: "organization-anthropic-key", value: $org}, {name: "personal-anthropic-key", value: $pkey},
   {name: "s3-access-key", value: $s3a}, {name: "s3-secret-key", value: $s3s},
   {name: "browser-session-cookie", value: ($browser[0].cookie // "")},
   {name: "browser-csrf-token", value: ($browser[0].csrf // "")}]
  | map(select(.value != ""))' >"$secrets/runner-values.json"
if [ -s "$out/work/values.json" ]; then
  jq -s 'add' "$out/work/values.json" "$secrets/runner-values.json" >"$secrets/values.json"
else
  fail "the harness wrote no values.json"
  cp "$secrets/runner-values.json" "$secrets/values.json"
fi
sweep_files=(
  "$out/work/s3.jsonl" "$out/work/backend-console.txt" "$out/work/telemetry.jsonl" "$out/work/responses.jsonl"
  "$out/work/console.txt" "$out/pod.log" "$out/browser-output.txt" "$out/browser-responses.jsonl" "$work/browser.log"
)
[ -e "${job_logs[0]}" ] && sweep_files+=("${job_logs[@]}")
"$NODE" "$here/leak-sweep.mjs" "$secrets/values.json" "${sweep_files[@]}" >"$work/sweep.log" 2>&1
sweep_status=$?
sed 's/^/       /' "$work/sweep.log"
if [ "$sweep_status" == 0 ]; then
  pass "leak sweep: no known value in ${#sweep_files[@]} outputs"
else
  fail "leak sweep: $(grep -c '^FAIL' "$work/sweep.log") FAIL lines (above)"
fi

finish
