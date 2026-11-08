# Shared parts of the attack test scripts (Story 7.1, 7.2, 7.4). Sourced, not run:
#
#   here="$(cd "$(dirname "$0")" && pwd)"
#   . "$here/lib.sh"
#
# Gives: settings (release, namespaces, image tag, run IDs), a work folder
# removed on exit, ok/FAIL counting (pass, fail, finish), diagnostics,
# setup_or_die, wait_for, install_chart, start_run and run_pod.
# Override binaries with KUBECTL, HELM, NODE.

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
NODE="${NODE:-node}"

RELEASE="runner-monitor"
NS="runner-monitor"            # release namespace
DEBUG_NS="debug-it"            # debugIt.debugNamespace in values-attack.yaml
JOB_IMAGE_TAG="attack-test"    # debugIt.jobImage.tag in values-attack.yaml
BACKEND_LABEL="app=github-runner-monitor-backend"
WAIT_SECONDS="${WAIT_SECONDS:-180}"

root="$(cd "$here/../../.." && pwd)"
chart="$root/helm/chart"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "ok   - $1"; }
fail() { failed=$((failed + 1)); echo "FAIL - $1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/       /'; }
k() { "$KUBECTL" "$@"; }

diagnostics() {
  echo "# Diagnostics"
  for cmd in \
    "get nodes -o wide" \
    "get pods -A -o wide" \
    "get networkpolicies -A -o yaml" \
    "get jobs,secrets -n $DEBUG_NS" \
    "describe pods -n $DEBUG_NS" \
    "describe pods -n $NS" \
    "get events -A --sort-by=.lastTimestamp"; do
    echo "## kubectl $cmd"
    # shellcheck disable=SC2086
    k $cmd 2>&1 | sed 's/^/    /'
  done
  # DIAGNOSTIC_LOGS=0 (Story 7.4): the logs may hold a leaked value, which
  # the leak sweep reports by name instead of printing it.
  if [ "${DIAGNOSTIC_LOGS:-1}" = "0" ]; then
    echo "## backend and Debug Job logs: not printed (DIAGNOSTIC_LOGS=0)"
    return
  fi
  echo "## backend logs"
  k logs -n "$NS" -l "$BACKEND_LABEL" --tail=200 2>&1 | sed 's/^/    /'
  for pod in $(k get pods -n "$DEBUG_NS" -o name 2>/dev/null); do
    echo "## logs $pod"
    k logs -n "$DEBUG_NS" "$pod" --all-containers --tail=100 2>&1 | sed 's/^/    /'
  done
}

finish() {
  echo
  echo "$passed passed, $failed failed"
  if [ "$failed" -gt 0 ]; then
    diagnostics
    exit 1
  fi
  exit 0
}

# Fails the whole test when setup does not work: nothing after it can prove anything.
setup_or_die() { # name, command...
  local name="$1" out
  shift
  if out="$("$@" 2>&1)"; then
    pass "$name"
  else
    fail "$name" "$out"
    finish
  fi
}

# Waits until the pod's jsonpath matches a regex. pod, namespace, jsonpath, regex[, seconds]
wait_for() {
  local pod="$1" ns="$2" path="$3" want="$4" limit="${5:-$WAIT_SECONDS}" got="" i
  for ((i = 0; i < limit; i += 2)); do
    got="$(k get pod "$pod" -n "$ns" -o "jsonpath=$path" 2>/dev/null)"
    [[ "$got" =~ $want ]] && return 0
    sleep 2
  done
  echo "pod $pod: '$path' is '$got', expected /$want/"
  return 1
}

# Namespaces, fake Secrets and the chart with Debug it on (values-attack.yaml).
install_chart() {
  echo "# Setup: namespaces, fake Secrets, chart with Debug it on"
  setup_or_die "namespace $NS" "$KUBECTL" create namespace "$NS"
  setup_or_die "namespace $DEBUG_NS" "$KUBECTL" create namespace "$DEBUG_NS"
  # Known fake values only. Mock mode never uses them, but the Deployment
  # refers to these Secrets, so they must exist.
  setup_or_die "fake GitHub token Secret" "$KUBECTL" create secret generic github-runner-monitor-token -n "$NS" \
    --from-literal=token=attack-test-github-token --from-literal=webhookSecret=attack-test-webhook-secret
  setup_or_die "fake GitHub App Secret" "$KUBECTL" create secret generic acme-debug-it-app -n "$NS" \
    --from-literal=privateKey=attack-test-not-a-private-key --from-literal=clientSecret=attack-test-client-secret
  setup_or_die "fake encryption Secret" "$KUBECTL" create secret generic acme-debug-it-encryption -n "$NS" \
    --from-literal=personalKeyEncryptionKey="$(printf 'a%.0s' {1..64})" \
    --from-literal=sessionEncryptionKey="$(printf 'b%.0s' {1..64})"
  setup_or_die "fake Anthropic key Secret" "$KUBECTL" create secret generic acme-anthropic -n "$NS" \
    --from-literal=apiKey=sk-ant-attack-test-organization
  setup_or_die "helm install with Debug it on" \
    "$HELM" install "$RELEASE" "$chart" --namespace "$NS" \
    -f "$root/helm/values-backend.yaml" -f "$root/helm/tests/values-debug-it.yaml" -f "$here/values-attack.yaml" \
    --wait --timeout 5m
}

# The installed job template, as startRun reads it.
job_template() {
  k get configmap debug-it-job-template -n "$NS" -o jsonpath='{.data.job\.json}'
}

# Starts one run with the backend's own buildJob/buildSecret (runs.ts):
# creates the Job, then its Secret owned by the Job. JOB_FILTER and
# SECRET_FILTER are jq programs applied to each before it is created
# (default: unchanged). Sets job_uid[runId].
declare -A job_uid
start_run() { # runId, label, template
  local run="$1" label="$2" template="$3" job uid secret out
  if ! job="$("$NODE" "$here/runs.ts" job "$run" "$JOB_IMAGE_TAG" <<<"$template" 2>&1)"; then
    fail "$label: buildJob" "$job"
    return 1
  fi
  if ! job="$(jq -c "${JOB_FILTER:-.}" <<<"$job" 2>&1)"; then
    fail "$label: Job changed for the test" "$job"
    return 1
  fi
  if ! uid="$(k create -n "$DEBUG_NS" -f - -o 'jsonpath={.metadata.uid}' <<<"$job" 2>&1)"; then
    fail "$label: Job created" "$uid"
    return 1
  fi
  job_uid[$run]="$uid"
  if ! secret="$("$NODE" "$here/runs.ts" secret "$run" "$uid" 2>&1)"; then
    fail "$label: buildSecret" "$secret"
    return 1
  fi
  # Never print the Secret (a filter may have put a real value in it).
  if ! secret="$(jq -c "${SECRET_FILTER:-.}" <<<"$secret" 2>/dev/null)"; then
    fail "$label: Secret changed for the test"
    return 1
  fi
  if ! out="$(k create -n "$DEBUG_NS" -f - <<<"$secret" 2>&1)"; then
    fail "$label: Secret created" "$out"
    return 1
  fi
  pass "$label: Job debug-it-$run and its Secret created"
}

# The run's pod name, once the Job controller has created it.
run_pod() {
  local name="" i
  for ((i = 0; i < WAIT_SECONDS; i += 2)); do
    name="$(k get pods -n "$DEBUG_NS" -l "debug-it/run-id=$1" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)"
    [ -n "$name" ] && break
    sleep 2
  done
  echo "$name"
}
