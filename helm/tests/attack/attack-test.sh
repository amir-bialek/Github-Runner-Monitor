#!/usr/bin/env bash
# Story 7.1: attack tests for the Debug Job network rules (SR3) and the
# per-run Secret split (SR1, SR2, SR11), against a real cluster that enforces
# NetworkPolicies (kind with Calico, see .github/workflows/attack-tests.yml).
#
#   bash helm/tests/attack/attack-test.sh
#
# Expects: the current kubectl context on that cluster, the images
# backend:attack-test and debug-job:attack-test loaded into it, helm 3, node
# 24 (type stripping), jq. Override binaries with KUBECTL, HELM, NODE.
#
# Installs the chart with Debug it on and invented values, then:
#   1. probes from a pod with the Debug Job labels (forbidden targets fail,
#      allowed ones answer) and from a control pod without them;
#   2. starts two runs with the backend's own buildJob/buildSecret from the
#      installed job template, and checks each pod sees only its own Secret;
#   3. checks the backend ServiceAccount cannot read or list Secrets.
# Only invented names and known fake values; no repository secret.
# Prints ok/FAIL lines; any FAIL exits 1 after dumping diagnostics.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helm/tests/attack/lib.sh
. "$here/lib.sh"

PROBE_IMAGE="debug-job:attack-test"
BACKEND_SVC="backend.${NS}.svc.cluster.local"
BACKEND_SA="backend-debug-it"
MAIN_PORT=3001
RESULTS_PORT=3002
# Two runs: the backend only accepts UUID run IDs.
RUN1="a77ac000-0000-4000-8000-000000000001"   # attackrun1
RUN2="a77ac000-0000-4000-8000-000000000002"   # attackrun2

install_chart

backend_pod="$(k get pods -n "$NS" -l "$BACKEND_LABEL" -o jsonpath='{.items[0].metadata.name}')"
backend_ip="$(k get pods -n "$NS" -l "$BACKEND_LABEL" -o jsonpath='{.items[0].status.podIP}')"
api_server="$(k get endpoints kubernetes -n default -o jsonpath='{.subsets[0].addresses[0].ip}:{.subsets[0].ports[0].port}' 2>/dev/null)"
[ -n "$backend_ip" ] && pass "backend pod $backend_pod at $backend_ip" || { fail "backend pod has an IP"; finish; }
[[ "$api_server" =~ ^[0-9a-f.:]+:[0-9]+$ ]] && pass "API server endpoint $api_server" || { fail "API server endpoint found" "$api_server"; finish; }

echo "# Setup: bystander pods (no policy of their own) and the probe script"
bystander() { # name, namespace
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $1
  namespace: $2
  labels:
    app: attack-bystander
spec:
  automountServiceAccountToken: false
  containers:
  - name: http
    image: $PROBE_IMAGE
    imagePullPolicy: Never
    command: [node, -e, "require('http').createServer((q, s) => s.end('bystander')).listen(8080)"]
    ports:
    - containerPort: 8080
    readinessProbe:
      tcpSocket:
        port: 8080
      periodSeconds: 2
EOF
}
{ bystander bystander-release "$NS"; echo ---; bystander bystander-debug "$DEBUG_NS"; } >"$work/bystanders.yaml"
setup_or_die "bystander pods created" "$KUBECTL" apply -f "$work/bystanders.yaml"
setup_or_die "bystander pod ready in $NS" \
  "$KUBECTL" wait --for=condition=Ready pod/bystander-release -n "$NS" --timeout="${WAIT_SECONDS}s"
setup_or_die "bystander pod ready in $DEBUG_NS" \
  "$KUBECTL" wait --for=condition=Ready pod/bystander-debug -n "$DEBUG_NS" --timeout="${WAIT_SECONDS}s"
bystanders="release=$(k get pod bystander-release -n "$NS" -o jsonpath='{.status.podIP}'):8080"
bystanders="$bystanders,debug=$(k get pod bystander-debug -n "$DEBUG_NS" -o jsonpath='{.status.podIP}'):8080"
setup_or_die "probe script ConfigMap" \
  "$KUBECTL" create configmap attack-probe -n "$DEBUG_NS" --from-file=probe.mjs="$here/probe.mjs"

probe_pod() { # name, mode, labels (YAML lines, already indented)
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $1
  namespace: $DEBUG_NS
  labels:
$3
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  containers:
  - name: probe
    image: $PROBE_IMAGE
    imagePullPolicy: Never
    command: [node, /probe/probe.mjs]
    env:
    - {name: PROBE_MODE, value: "$2"}
    - {name: BACKEND_SVC, value: "$BACKEND_SVC"}
    - {name: BACKEND_POD_IP, value: "$backend_ip"}
    - {name: MAIN_PORT, value: "$MAIN_PORT"}
    - {name: RESULTS_PORT, value: "$RESULTS_PORT"}
    - {name: API_SERVER, value: "$api_server"}
    - {name: BYSTANDERS, value: "$bystanders"}
    volumeMounts:
    - {name: probe, mountPath: /probe, readOnly: true}
  volumes:
  - name: probe
    configMap:
      name: attack-probe
EOF
}

run_probe() { # name, mode, labels
  local name="$1" out phase
  if ! out="$(probe_pod "$@" | k apply -f - 2>&1)"; then
    fail "$name pod created" "$out"
    return
  fi
  if ! out="$(wait_for "$name" "$DEBUG_NS" '{.status.phase}' '^(Succeeded|Failed)$')"; then
    fail "$name pod finished" "$out"
    return
  fi
  phase="$(k get pod "$name" -n "$DEBUG_NS" -o jsonpath='{.status.phase}')"
  out="$(k logs "$name" -n "$DEBUG_NS" 2>&1)"
  # Count the probe's own lines into the totals.
  while IFS= read -r line; do
    case "$line" in
      "ok   - "*) pass "${line#ok   - }" ;;
      "FAIL - "*) fail "${line#FAIL - }" ;;
      *) echo "       $line" ;;
    esac
  done <<<"$out"
  grep -q '^ok   - ' <<<"$out" || fail "$name printed no result" "$out"
  [ "$phase" == "Succeeded" ] && pass "$name exited 0" || fail "$name exited 0 (phase $phase)"
}

echo "# SR3: probe from a pod with the Debug Job labels"
run_probe attack-probe-job job "    app.kubernetes.io/name: debug-it-job
    app.kubernetes.io/part-of: github-runner-monitor"

echo "# SR3 control: probe from a pod without the Debug Job labels"
run_probe attack-probe-control control "    app: attack-control"

echo "# SR1, SR2, SR11: two runs from the installed job template"
template="$(job_template)"
[ -n "$template" ] && pass "job template read back from the installed ConfigMap" || { fail "job template read back"; finish; }

# Secret keys a container mounts ("ALL" for a Secret volume without items).
mounted_keys() { # pod JSON, container name
  jq -r --arg c "$2" '
    . as $p
    | [($p.spec.initContainers // []) + $p.spec.containers | .[] | select(.name == $c) | .volumeMounts[]?.name] as $m
    | [$p.spec.volumes[] | select(.name as $n | $m | index($n)) | select(.secret)
       | if .secret.items then .secret.items[].key else "ALL" end] | sort | join(",")' <<<"$1"
}

# Checks on one run, with the other run's values as the ones it must not see.
inspect_run() { # runId, label, other runId
  local run="$1" label="$2" other="$3" pod spec out got
  local key="sk-ant-attack-test-$run" upload="attack-upload-$run"
  local other_key="sk-ant-attack-test-$other" other_upload="attack-upload-$other" other_result="attack-result-$other"
  pod="$(run_pod "$run")"
  if [ -z "$pod" ]; then
    fail "$label: pod exists"
    return
  fi
  # Regular init containers run in order: while the run waits for its upload,
  # only the receiver is running.
  if ! out="$(wait_for "$pod" "$DEBUG_NS" \
    '{.status.initContainerStatuses[?(@.name=="receiver")].state.running.startedAt}' '.')"; then
    fail "$label: receiver running" "$out"
    return
  fi
  pass "$label: pod $pod, receiver running"

  # The Secret: owned by the run's Job, as startRun does.
  got="$(k get secret "debug-it-$run" -n "$DEBUG_NS" -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].uid}/{.metadata.ownerReferences[0].controller}')"
  [ "$got" == "Job/${job_uid[$run]}/true" ] && pass "$label: Secret owned by its Job" \
    || fail "$label: Secret owned by its Job" "$got"

  # The admitted pod spec: what the kubelet runs, after any admission change.
  spec="$(k get pod "$pod" -n "$DEBUG_NS" -o json)"
  got="$(jq -r '[.spec.volumes[] | select(.secret) | .secret.secretName] | unique | join(",")' <<<"$spec")"
  [ "$got" == "debug-it-$run" ] && pass "$label: Secret volumes name only debug-it-<own run>" \
    || fail "$label: Secret volumes name only debug-it-<own run>" "$got"
  got="$(jq --arg o "$other" '[.. | strings | select(contains($o))] | length' <<<"$spec")"
  [ "$got" == "0" ] && pass "$label: pod spec never names the other run" || fail "$label: pod spec never names the other run" "$got"
  got="$(jq -r '[.spec.automountServiceAccountToken, ([.spec.volumes[] | select(.projected or .csi or .hostPath)] | length)] | @tsv' <<<"$spec")"
  [ "$got" == $'false\t0' ] && pass "$label: no service account token, projected, CSI or host volume" \
    || fail "$label: no service account token, projected, CSI or host volume" "$got"

  got="$(mounted_keys "$spec" claude)"
  [ "$got" == "result-code" ] && pass "$label: claude mounts only the result code" \
    || fail "$label: claude mounts only the result code" "$got"
  got="$(mounted_keys "$spec" receiver)"
  [ "$got" == "upload-code" ] && pass "$label: receiver mounts only the upload code" \
    || fail "$label: receiver mounts only the upload code" "$got"
  got="$(mounted_keys "$spec" key-helper)"
  [ "$got" == "anthropic-api-key" ] && pass "$label: key helper mounts only the Anthropic key" \
    || fail "$label: key helper mounts only the Anthropic key" "$got"
  got="$(jq -r '.spec.containers[] | select(.name == "claude") | [.volumeMounts[]?.mountPath | select(startswith("/var/run/secrets") or startswith("/run/secrets"))] | join(",")' <<<"$spec")"
  [ -z "$got" ] && pass "$label: claude has no service account token mount" \
    || fail "$label: claude has no service account token mount" "$got"
  got="$(jq -r '.spec.containers[] | select(.name == "claude")
    | ([.env[]? | select(.valueFrom.secretKeyRef or .valueFrom.serviceAccountToken) | .name]
       + [.envFrom[]? | tostring]
       + [.env[]? | .name | select(test("^(ANTHROPIC_|CLAUDE_CODE_OAUTH|GITHUB_TOKEN|GH_TOKEN|GITHUB_APP|AWS_|AZURE_|GOOGLE_)"))]
       + [.env[]? | select((.value // "") | test("sk-ant-")) | .name])
    | join(",")' <<<"$spec")"
  [ -z "$got" ] && pass "$label: claude has no key, token or cloud credential in its env" \
    || fail "$label: claude has no key, token or cloud credential in its env" "$got"

  # The running receiver: its own upload code, nothing else.
  got="$(k exec -n "$DEBUG_NS" "$pod" -c receiver -- cat /secrets/upload/upload-code 2>&1)"
  [ "$got" == "$upload" ] && pass "$label: receiver reads its own upload code" \
    || fail "$label: receiver reads its own upload code" "$got"
  got="$(k exec -n "$DEBUG_NS" "$pod" -c receiver -- sh -c 'ls -A /secrets; ls /secrets/upload' 2>&1)"
  [ "$got" == $'upload\nupload-code' ] && pass "$label: receiver sees no other Secret file" \
    || fail "$label: receiver sees no other Secret file" "$got"
  got="$(k exec -n "$DEBUG_NS" "$pod" -c receiver -- sh -c '
    test -e /var/run/secrets/kubernetes.io/serviceaccount && echo "service account token mounted"
    for v in "$@"; do grep -rqsF -- "$v" /secrets /proc/1/environ && echo "found a value it must not hold"; done
    true' sh "$key" "$other_key" "$other_upload" "$other_result" "attack-result-$run" 2>&1)"
  [ -z "$got" ] && pass "$label: receiver holds no key, other code or token" \
    || fail "$label: receiver holds no key, other code or token" "$got"
}

if start_run "$RUN1" attackrun1 "$template" && start_run "$RUN2" attackrun2 "$template"; then
  inspect_run "$RUN1" attackrun1 "$RUN2"
  inspect_run "$RUN2" attackrun2 "$RUN1"
fi

echo "# SR2: the backend ServiceAccount cannot read Secrets"
as_sa="system:serviceaccount:$NS:$BACKEND_SA"
can_i() { # verb, scope args...
  local verb="$1"
  shift
  k auth can-i "$verb" secrets --as="$as_sa" "$@" 2>/dev/null
}
for scope in "-n $DEBUG_NS" "-n $NS" "--all-namespaces"; do
  for verb in get list watch; do
    # shellcheck disable=SC2086
    got="$(can_i "$verb" $scope)"
    [[ "$got" == no* ]] && pass "backend cannot $verb Secrets ($scope)" || fail "backend cannot $verb Secrets ($scope)" "$got"
  done
done
for verb in create delete; do
  got="$(can_i "$verb" -n "$DEBUG_NS")"
  [[ "$got" == yes* ]] && pass "backend can $verb Secrets (-n $DEBUG_NS)" || fail "backend can $verb Secrets (-n $DEBUG_NS)" "$got"
done

# The same, tried for real with the ServiceAccount's own token.
server="$(k config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
ca="$(k config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
if token="$(k create token "$BACKEND_SA" -n "$NS" --duration=10m 2>&1)"; then
  cat >"$work/backend.kubeconfig" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: attack
  cluster: {server: "$server", certificate-authority-data: "$ca"}
users:
- name: backend
  user: {token: "$token"}
contexts:
- name: backend
  context: {cluster: attack, user: backend}
current-context: backend
EOF
  as_backend() { "$KUBECTL" --kubeconfig "$work/backend.kubeconfig" "$@"; }
  expect_forbidden() { # name, kubectl args...
    local name="$1" out
    shift
    if out="$(as_backend "$@" 2>&1)"; then
      fail "$name (allowed, must be forbidden)" "$(head -c 300 <<<"$out")"
    elif grep -qi 'forbidden' <<<"$out"; then
      pass "$name"
    else
      fail "$name (failed, but not as forbidden)" "$out"
    fi
  }
  expect_forbidden "backend token: get run Secret refused" get secret "debug-it-$RUN1" -n "$DEBUG_NS"
  expect_forbidden "backend token: list Secrets in $DEBUG_NS refused" get secrets -n "$DEBUG_NS"
  expect_forbidden "backend token: get Secret in $NS refused" get secret acme-anthropic -n "$NS"
  expect_forbidden "backend token: list Secrets in $NS refused" get secrets -n "$NS"
  expect_forbidden "backend token: list Secrets cluster-wide refused" get secrets --all-namespaces
  if out="$(as_backend create secret generic attack-rbac-probe -n "$DEBUG_NS" --from-literal=probe=attack-test 2>&1)"; then
    pass "backend token: create Secret in $DEBUG_NS allowed"
  else
    fail "backend token: create Secret in $DEBUG_NS allowed" "$out"
  fi
  if out="$(as_backend delete secret attack-rbac-probe -n "$DEBUG_NS" 2>&1)"; then
    pass "backend token: delete Secret in $DEBUG_NS allowed"
  else
    fail "backend token: delete Secret in $DEBUG_NS allowed" "$out"
  fi
else
  fail "backend ServiceAccount token issued" "$token"
fi

finish
