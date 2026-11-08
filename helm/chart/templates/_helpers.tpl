{{/*
Expand the name of the chart.
*/}}
{{- define "template.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "template.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "template.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "template.labels" -}}
helm.sh/chart: {{ include "template.chart" . }}
{{ include "template.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "template.selectorLabels" -}}
app.kubernetes.io/name: {{ include "template.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "template.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "template.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Debug it (story 1.2).

Every Debug it line in the templates is guarded by "debugIt.active", which is
"true" only when debugIt.enabled is true AND this release is the backend
(deployment.name "backend", the load-bearing Service name). A debugIt block in
the frontend release therefore renders nothing.
*/}}
{{- define "debugIt.active" -}}
{{- if and (eq (toString .Values.deployment.name) "backend") (hasKey .Values "debugIt") -}}
{{- if kindIs "map" .Values.debugIt -}}
{{- if eq (toString .Values.debugIt.enabled) "true" -}}
true
{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
A Helm value as an env string. Numbers from a values file arrive as float64,
and toString would print 2097152 as "2.097152e+06", so whole numbers are
printed as integers and decimals as they are.
*/}}
{{- define "debugIt.scalar" -}}
{{- if and (kindIs "float64" .) (eq (float64 (int64 .)) .) -}}
{{- int64 . -}}
{{- else if kindIs "invalid" . -}}
{{- else -}}
{{- toString . -}}
{{- end -}}
{{- end }}

{{/*
A list value joined with commas. Fails when the value is not a list.
Usage: include "debugIt.list" (list "debugIt.administrators" $value)
*/}}
{{- define "debugIt.list" -}}
{{- $path := index . 0 -}}
{{- $value := index . 1 -}}
{{- if kindIs "invalid" $value -}}
{{- else if kindIs "slice" $value -}}
{{- $items := list -}}
{{- range $value }}{{ $items = append $items (include "debugIt.scalar" .) }}{{ end -}}
{{- join "," $items -}}
{{- else -}}
{{- fail (printf "%s must be a list, for example [acme-admin]" $path) -}}
{{- end -}}
{{- end }}

{{/*
Checks one Secret reference. Secret values are never accepted in Helm values:
a plain string fails, and so does a reference missing its name or key.
Usage: include "debugIt.secretRef" (dict "path" "debugIt.x" "value" $v "required" true "needKey" true)
Prints "true" when a complete reference is set, nothing otherwise.
*/}}
{{- define "debugIt.secretRef" -}}
{{- $path := .path -}}
{{- $value := .value -}}
{{- $example := ternary "{ name, key }" "{ name }" .needKey -}}
{{- if or (kindIs "invalid" $value) (and (kindIs "string" $value) (eq $value "")) -}}
{{- if .required -}}
{{- fail (printf "Debug it is enabled but %s is missing: set it to a Secret reference %s" $path $example) -}}
{{- end -}}
{{- else if not (kindIs "map" $value) -}}
{{- fail (printf "%s must be a Secret reference %s, not a value: secret values are not accepted in Helm values" $path $example) -}}
{{- else -}}
{{- $name := include "debugIt.scalar" $value.name -}}
{{- $key := include "debugIt.scalar" $value.key -}}
{{- if and (eq $name "") (not .required) -}}
{{- else if eq $name "" -}}
{{- fail (printf "Debug it is enabled but %s.name is missing: set it to the name of an existing Kubernetes Secret" $path) -}}
{{- else if and .needKey (eq $key "") -}}
{{- fail (printf "Debug it is enabled but %s.key is missing: set it to the key inside Secret %s" $path $name) -}}
{{- else -}}
true
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Fails rendering, naming the value, when Debug it is on and a required value is
missing or Debug it cannot run (autoscaling). Prints nothing.
*/}}
{{- define "debugIt.validate" -}}
{{- if eq (include "debugIt.active" .) "true" -}}
{{- $d := .Values.debugIt -}}
{{- $deploy := .Values.deployment -}}
{{- $autoscaling := default dict $deploy.autoscaling -}}
{{- if eq (toString $autoscaling.enabled) "true" -}}
{{- fail "Debug it is enabled but deployment.autoscaling.enabled is true: Debug it runs exactly one backend pod, so turn autoscaling off" -}}
{{- end -}}
{{- $env := default dict $deploy.env -}}
{{- $regular := default dict $env.regular -}}
{{- if eq (include "debugIt.scalar" $regular.JOB_STATE_S3_BUCKET) "" -}}
{{- fail "Debug it is enabled but deployment.env.regular.JOB_STATE_S3_BUCKET (the S3 bucket) is missing" -}}
{{- end -}}
{{- $webhook := false -}}
{{- range (default list $env.fromSecrets) -}}
{{- if and (eq (toString .envName) "GITHUB_WEBHOOK_SECRET") .secretName .secretKey -}}
{{- $webhook = true -}}
{{- end -}}
{{- end -}}
{{- if not $webhook -}}
{{- fail "Debug it is enabled but the webhook secret is missing: add a deployment.env.fromSecrets entry with envName GITHUB_WEBHOOK_SECRET, secretName and secretKey" -}}
{{- end -}}
{{- $mode := toString (default "organization" $d.credentialsMode) -}}
{{- if not (has $mode (list "organization" "personal")) -}}
{{- fail (printf "debugIt.credentialsMode must be organization or personal, not %q" $mode) -}}
{{- end -}}
{{- $scope := toString (default "debug-it-only" $d.loginScope) -}}
{{- if not (has $scope (list "debug-it-only" "whole-dashboard")) -}}
{{- fail (printf "debugIt.loginScope must be debug-it-only or whole-dashboard, not %q" $scope) -}}
{{- end -}}
{{- $app := $d.githubApp -}}
{{- if and (not (kindIs "invalid" $app)) (not (kindIs "map" $app)) -}}
{{- fail "debugIt.githubApp must be a map with appId, clientId, privateKeySecret and clientSecretSecret" -}}
{{- end -}}
{{- $app = default dict $app -}}
{{- if eq (include "debugIt.scalar" $app.appId) "" -}}
{{- fail "Debug it is enabled but debugIt.githubApp.appId is missing" -}}
{{- end -}}
{{- $_ := include "debugIt.secretRef" (dict "path" "debugIt.githubApp.privateKeySecret" "value" $app.privateKeySecret "required" true "needKey" true) -}}
{{- if eq (include "debugIt.scalar" $app.clientId) "" -}}
{{- fail "Debug it is enabled but debugIt.githubApp.clientId is missing" -}}
{{- end -}}
{{- $_ := include "debugIt.secretRef" (dict "path" "debugIt.githubApp.clientSecretSecret" "value" $app.clientSecretSecret "required" true "needKey" true) -}}
{{- $admins := include "debugIt.list" (list "debugIt.administrators" $d.administrators) -}}
{{- if eq $admins "" -}}
{{- fail "Debug it is enabled but debugIt.administrators is missing: list at least one GitHub numeric user ID" -}}
{{- end -}}
{{- $_ := include "debugIt.list" (list "debugIt.allowedRepositories" $d.allowedRepositories) -}}
{{- $_ := include "debugIt.list" (list "debugIt.allowedUsers" $d.allowedUsers) -}}
{{- range (concat (default list $d.administrators) (default list $d.allowedUsers)) -}}
{{- if not (regexMatch "^[0-9]+$" (include "debugIt.scalar" .)) -}}
{{- fail (printf "debugIt.administrators and debugIt.allowedUsers take GitHub numeric user IDs, not %q" (toString .)) -}}
{{- end -}}
{{- end -}}
{{- $url := include "debugIt.scalar" $d.publicUrl -}}
{{- if eq $url "" -}}
{{- fail "Debug it is enabled but debugIt.publicUrl (PUBLIC_URL) is missing" -}}
{{- end -}}
{{- if not (regexMatch "^https?://" $url) -}}
{{- fail (printf "debugIt.publicUrl must start with https:// or http://, not %q" $url) -}}
{{- end -}}
{{- $_ := include "debugIt.secretRef" (dict "path" "debugIt.encryptionSecret" "value" $d.encryptionSecret "required" true "needKey" false) -}}
{{- $_ := include "debugIt.secretRef" (dict "path" "debugIt.anthropicApiKeySecret" "value" $d.anthropicApiKeySecret "required" (eq $mode "organization") "needKey" true) -}}
{{- $image := $d.jobImage -}}
{{- if and (not (kindIs "invalid" $image)) (not (kindIs "map" $image)) -}}
{{- fail "debugIt.jobImage must be a map with repository and tag" -}}
{{- end -}}
{{- $image = default dict $image -}}
{{- if eq (include "debugIt.scalar" $image.repository) "" -}}
{{- fail "Debug it is enabled but debugIt.jobImage.repository (the Debug Job image, without tag) is missing" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$" (include "debugIt.jobImageTag" .)) -}}
{{- fail (printf "debugIt.jobImage.tag must be a plain image tag such as 1.2.0, not %q" (include "debugIt.jobImageTag" .)) -}}
{{- end -}}
{{- if eq (include "debugIt.scalar" $d.debugNamespace) "" -}}
{{- fail "Debug it is enabled but debugIt.debugNamespace is missing" -}}
{{- end -}}
{{- $telemetry := default dict $d.costTelemetry -}}
{{- if not (kindIs "map" $telemetry) -}}
{{- fail "debugIt.costTelemetry must be a map with enabled, endpoint and apiKeySecret" -}}
{{- end -}}
{{- if eq (toString $telemetry.enabled) "true" -}}
{{- $endpoint := include "debugIt.scalar" $telemetry.endpoint -}}
{{- if eq $endpoint "" -}}
{{- fail "debugIt.costTelemetry.enabled is true but debugIt.costTelemetry.endpoint (the OTLP/HTTP collector URL) is missing" -}}
{{- end -}}
{{- if not (regexMatch "^https?://" $endpoint) -}}
{{- fail (printf "debugIt.costTelemetry.endpoint must start with https:// or http://, not %q" $endpoint) -}}
{{- end -}}
{{- end -}}
{{- $_ := include "debugIt.secretRef" (dict "path" "debugIt.costTelemetry.apiKeySecret" "value" $telemetry.apiKeySecret "required" false "needKey" true) -}}
{{- if not ((include "debugIt.backendService" . | fromJson).name) -}}
{{- fail "Debug it is enabled but no service.services entry has selectDeployment true: the Debug Job needs the backend Service for its results" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Debug it env entries for the backend container. Settings go in as plain
values (lists comma-joined); secrets only as secretKeyRef, never as values.
Call only when "debugIt.active" is "true" and after "debugIt.validate".
*/}}
{{- define "debugIt.env" -}}
{{- $d := .Values.debugIt -}}
{{- $app := default dict $d.githubApp -}}
{{- $limits := default dict $d.limits -}}
{{- $telemetry := default dict $d.costTelemetry -}}
{{- $mode := toString (default "organization" $d.credentialsMode) -}}
{{- $plain := list
  (list "DEBUG_IT_ENABLED" "true")
  (list "DEBUG_IT_CREDENTIALS_MODE" $mode)
  (list "DEBUG_IT_MONTHLY_CAP" (include "debugIt.scalar" $d.monthlyCap))
  (list "DEBUG_IT_LOGIN_SCOPE" (toString (default "debug-it-only" $d.loginScope)))
  (list "DEBUG_IT_ADMINISTRATORS" (include "debugIt.list" (list "debugIt.administrators" $d.administrators)))
  (list "DEBUG_IT_ALLOWED_REPOSITORIES" (include "debugIt.list" (list "debugIt.allowedRepositories" $d.allowedRepositories)))
  (list "DEBUG_IT_ALLOWED_USERS" (include "debugIt.list" (list "debugIt.allowedUsers" $d.allowedUsers)))
  (list "DEBUG_IT_PUBLIC_URL" (include "debugIt.scalar" $d.publicUrl))
  (list "DEBUG_IT_GITHUB_APP_ID" (include "debugIt.scalar" $app.appId))
  (list "DEBUG_IT_GITHUB_APP_CLIENT_ID" (include "debugIt.scalar" $app.clientId))
  (list "DEBUG_IT_NAMESPACE" (include "debugIt.scalar" $d.debugNamespace))
  (list "DEBUG_IT_MAX_CONCURRENT_RUNS" (include "debugIt.scalar" $limits.maxConcurrentRuns))
  (list "DEBUG_IT_MAX_RUNS_PER_USER" (include "debugIt.scalar" $limits.maxRunsPerUser))
  (list "DEBUG_IT_TIME_LIMIT_MINUTES" (include "debugIt.scalar" $limits.timeLimitMinutes))
  (list "DEBUG_IT_SPEND_LIMIT_USD" (include "debugIt.scalar" $limits.spendLimitUsd))
  (list "DEBUG_IT_LOG_LIMIT_BYTES" (include "debugIt.scalar" $limits.logLimitBytes))
  (list "DEBUG_IT_PATCH_LIMIT_BYTES" (include "debugIt.scalar" $limits.patchLimitBytes))
  (list "DEBUG_IT_ORGANIZATION_MONTHLY_SPEND_LIMIT_USD" (include "debugIt.scalar" $limits.organizationMonthlySpendLimitUsd))
  (list "DEBUG_IT_COST_TELEMETRY_ENABLED" (ternary "true" "false" (eq (toString $telemetry.enabled) "true")))
  (list "DEBUG_IT_COST_TELEMETRY_ENDPOINT" (include "debugIt.scalar" $telemetry.endpoint))
  (list "DEBUG_JOB_IMAGE_TAG" (include "debugIt.jobImageTag" .))
  (list "DEBUG_IT_RESULTS_PORT" (include "debugIt.resultsPort" .))
-}}
{{- range $plain }}
- name: {{ index . 0 }}
  value: {{ index . 1 | quote }}
{{- end }}
{{- $refs := list
  (list "DEBUG_IT_GITHUB_APP_PRIVATE_KEY" $app.privateKeySecret.name $app.privateKeySecret.key)
  (list "DEBUG_IT_GITHUB_APP_CLIENT_SECRET" $app.clientSecretSecret.name $app.clientSecretSecret.key)
  (list "DEBUG_IT_PERSONAL_KEY_ENCRYPTION_KEY" $d.encryptionSecret.name "personalKeyEncryptionKey")
  (list "DEBUG_IT_SESSION_ENCRYPTION_KEY" $d.encryptionSecret.name "sessionEncryptionKey")
-}}
{{- if eq (include "debugIt.secretRef" (dict "path" "debugIt.anthropicApiKeySecret" "value" $d.anthropicApiKeySecret "required" (eq $mode "organization") "needKey" true)) "true" -}}
{{- $refs = append $refs (list "DEBUG_IT_ANTHROPIC_API_KEY" $d.anthropicApiKeySecret.name $d.anthropicApiKeySecret.key) -}}
{{- end -}}
{{- if eq (include "debugIt.secretRef" (dict "path" "debugIt.costTelemetry.apiKeySecret" "value" $telemetry.apiKeySecret "required" false "needKey" true)) "true" -}}
{{- $refs = append $refs (list "DEBUG_IT_COST_TELEMETRY_API_KEY" $telemetry.apiKeySecret.name $telemetry.apiKeySecret.key) -}}
{{- end -}}
{{- range $refs }}
- name: {{ index . 0 }}
  valueFrom:
    secretKeyRef:
      name: {{ index . 1 | toString | quote }}
      key: {{ index . 2 | toString | quote }}
{{- end }}
- name: DEBUG_IT_JOB_TEMPLATE
  valueFrom:
    configMapKeyRef:
      name: debug-it-job-template
      key: job.json
- name: DEBUG_IT_CHECK_JOB_TEMPLATE
  valueFrom:
    configMapKeyRef:
      name: debug-it-job-template
      key: check-job.json
{{- end }}

{{/*
Debug it, story 3.5: names and objects shared by debug-it.yaml, service.yaml
and deployment.yaml. Call only when "debugIt.active" is "true".
*/}}

{{/* The backend Deployment's name, as deployment.yaml renders it. */}}
{{- define "debugIt.deploymentName" -}}
{{- if .Values.deployment.labels.kind -}}
{{- printf "%s-%s" (toString .Values.deployment.name) (toString .Values.deployment.labels.kind) -}}
{{- else -}}
{{- toString .Values.deployment.name -}}
{{- end -}}
{{- end }}

{{/*
The backend's ServiceAccount: serviceAccount.name when serviceAccount.enabled
is true (it may carry the S3 role annotation), otherwise the one debug-it.yaml
renders, <deployment name>-debug-it.
*/}}
{{- define "debugIt.serviceAccountName" -}}
{{- if and (hasKey .Values "serviceAccount") (eq .Values.serviceAccount.enabled true) -}}
{{- toString .Values.serviceAccount.name -}}
{{- else -}}
{{- printf "%s-debug-it" (include "debugIt.deploymentName" .) -}}
{{- end -}}
{{- end }}

{{/* Labels of every Debug Job and its pod (the 3.6 check Job reuses them). */}}
{{- define "debugIt.jobLabels" -}}
app.kubernetes.io/name: debug-it-job
app.kubernetes.io/part-of: github-runner-monitor
{{- end }}

{{/*
The first service.services entry with selectDeployment, as a dict with its
rendered name (service.yaml adds -<kind>), its port and its target port.
Empty name when there is none.
*/}}
{{- define "debugIt.backendService" -}}
{{- $top := .Values -}}
{{- $found := dict -}}
{{- if and $top.service $top.service.enabled $top.deployment.enabled -}}
{{- range (default list $top.service.services) -}}
{{- if and (not $found.name) .selectDeployment -}}
{{- $name := toString .name -}}
{{- if and (hasKey $top.deployment.labels "kind") $top.deployment.labels.kind -}}
{{- $name = printf "%s-%s" $name (toString $top.deployment.labels.kind) -}}
{{- end -}}
{{- $first := first (default (list dict) .ports) -}}
{{- $port := include "debugIt.scalar" $first.port -}}
{{- $target := include "debugIt.scalar" (default $first.port $first.targetPort) -}}
{{- $_ := set $found "name" $name -}}
{{- $_ := set $found "port" $port -}}
{{- $_ := set $found "targetPort" $target -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- toJson $found -}}
{{- end }}

{{/* debugIt.resultsPort, default 3002. */}}
{{- define "debugIt.resultsPort" -}}
{{- $port := include "debugIt.scalar" .Values.debugIt.resultsPort -}}
{{- if eq $port "" }}3002{{ else }}{{ $port }}{{ end -}}
{{- end }}

{{/* debugIt.jobImage.tag, default debug-job-v<chart appVersion> (AD-15). */}}
{{- define "debugIt.jobImageTag" -}}
{{- $image := default dict .Values.debugIt.jobImage -}}
{{- $tag := include "debugIt.scalar" $image.tag -}}
{{- if eq $tag "" }}{{ printf "debug-job-v%s" .Chart.AppVersion }}{{ else }}{{ $tag }}{{ end -}}
{{- end }}

{{/*
The Debug Job template (AD-8, AD-9), as YAML. The backend fills in only the
run ID (name, label, RUN_ID), the image tag, the Secret name, the time limit
(activeDeadlineSeconds, DEADLINE_AT) and the spend limit; every other field is
fixed here. Each Secret item has its own volume, mounted only into the one
container that needs it.
*/}}
{{- define "debugIt.jobTemplate" -}}
{{- $d := .Values.debugIt -}}
{{- $image := default dict $d.jobImage -}}
{{- $repository := include "debugIt.scalar" $image.repository -}}
{{- $service := include "debugIt.backendService" . | fromJson -}}
{{- $mainPort := default "3001" $service.port -}}
{{- $resultsUrl := printf "http://%s.%s.svc.cluster.local:%s" (toString $service.name) .Release.Namespace (include "debugIt.resultsPort" .) -}}
{{- $containerSecurity := dict "allowPrivilegeEscalation" false "readOnlyRootFilesystem" true "runAsNonRoot" true "capabilities" (dict "drop" (list "ALL")) -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: debug-it-run
  namespace: {{ include "debugIt.scalar" $d.debugNamespace | default "debug-it" | quote }}
  labels:
    {{- include "debugIt.jobLabels" . | nindent 4 }}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  activeDeadlineSeconds: 0
  template:
    metadata:
      labels:
        {{- include "debugIt.jobLabels" . | nindent 8 }}
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      enableServiceLinks: false
      shareProcessNamespace: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      initContainers:
      - name: receiver
        image: {{ $repository | quote }}
        command: [node, /app/src/receiver.ts]
        ports:
        - name: upload
          containerPort: 8080
          protocol: TCP
        env:
        - name: WORK_DIR
          value: /work
        - name: UPLOAD_PORT
          value: "8080"
        securityContext: {{ toYaml $containerSecurity | nindent 10 }}
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            memory: 256Mi
        volumeMounts:
        - name: work
          mountPath: /work
        - name: upload-code
          mountPath: /secrets/upload
          readOnly: true
      - name: key-helper
        image: {{ $repository | quote }}
        command: [node, /app/src/keyHelper.ts]
        restartPolicy: Always
        env:
        - name: KEY_HELPER_PORT
          value: "8081"
        securityContext: {{ toYaml $containerSecurity | nindent 10 }}
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            memory: 256Mi
        volumeMounts:
        - name: anthropic-key
          mountPath: /secrets/anthropic
          readOnly: true
      containers:
      - name: claude
        image: {{ $repository | quote }}
        command: [node, /app/src/wrapper.ts]
        env:
        - name: RUN_ID
          value: ""
        - name: DEADLINE_AT
          value: ""
        - name: SPEND_LIMIT_USD
          value: ""
        - name: RESULTS_URL
          value: {{ $resultsUrl | quote }}
        - name: WORK_DIR
          value: /work
        - name: STATE_DIR
          value: /wrapper
        - name: KEY_HELPER_PORT
          value: "8081"
        - name: BACKEND_MAIN_PORT
          value: {{ $mainPort | quote }}
        securityContext: {{ toYaml $containerSecurity | nindent 10 }}
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            memory: 2Gi
        volumeMounts:
        - name: work
          mountPath: /work
        - name: wrapper
          mountPath: /wrapper
        - name: result-code
          mountPath: /secrets/result
          readOnly: true
      volumes:
      - name: work
        emptyDir:
          sizeLimit: 768Mi
      - name: wrapper
        emptyDir:
          sizeLimit: 768Mi
      - name: anthropic-key
        secret:
          secretName: ""
          defaultMode: 288
          items:
          - key: anthropic-api-key
            path: api-key
      - name: upload-code
        secret:
          secretName: ""
          defaultMode: 288
          items:
          - key: upload-code
            path: upload-code
      - name: result-code
        secret:
          secretName: ""
          defaultMode: 288
          items:
          - key: result-code
            path: result-code
{{- end }}

{{/*
The startup isolation check Job template (story 3.6, FR31, AD-7), as YAML.
Same labels as a Debug Job (so the debug-it-job NetworkPolicy applies to it
unchanged) plus debug-it/check, same pod and container securityContext, no
Secret and no volume. The backend fills in only the name and the image tag.
*/}}
{{- define "debugIt.checkJobTemplate" -}}
{{- $d := .Values.debugIt -}}
{{- $image := default dict $d.jobImage -}}
{{- $repository := include "debugIt.scalar" $image.repository -}}
{{- $service := include "debugIt.backendService" . | fromJson -}}
{{- $mainPort := default "3001" $service.port -}}
{{- $resultsUrl := printf "http://%s.%s.svc.cluster.local:%s" (toString $service.name) .Release.Namespace (include "debugIt.resultsPort" .) -}}
{{- $containerSecurity := dict "allowPrivilegeEscalation" false "readOnlyRootFilesystem" true "runAsNonRoot" true "capabilities" (dict "drop" (list "ALL")) -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: debug-it-check
  namespace: {{ include "debugIt.scalar" $d.debugNamespace | default "debug-it" | quote }}
  labels:
    {{- include "debugIt.jobLabels" . | nindent 4 }}
    debug-it/check: "true"
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 120
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        {{- include "debugIt.jobLabels" . | nindent 8 }}
        debug-it/check: "true"
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: isolation-check
        image: {{ $repository | quote }}
        command: [node, /app/src/isolationCheck.ts]
        env:
        - name: RESULTS_URL
          value: {{ $resultsUrl | quote }}
        - name: BACKEND_MAIN_PORT
          value: {{ $mainPort | quote }}
        securityContext: {{ toYaml $containerSecurity | nindent 10 }}
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            memory: 256Mi
{{- end }}
