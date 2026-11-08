import axios from 'axios'
import type {
  AlertSettingsResponse,
  AlertSettingsUpdate,
  AlertsResponse,
  BackendSettings,
  DebugItRunsOverview,
  DebugItCredentialsMode,
  DebugItSession,
  DebugItSettingsView,
  DebugItUsageView,
  DebugFeedbackInput,
  DebugFixPullRequest,
  DebugRunResultView,
  DebugRunStart,
  DebugRunView,
  HistoryTarget,
  LoginScope,
  PersonalKeyDeleted,
  PersonalKeyStatus,
  WebhookStatus,
  HistoryJob,
  QueueResponse,
  Runner,
  RunningResponse,
  ScaleSet,
} from '../types/api'
import { ApiError, toApiError } from './apiError'

export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const REQUEST_TIMEOUT_MS = 10000
const CSRF_HEADER = 'X-CSRF-Token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
})

// Debug it CSRF token (AD-11). Held in memory only: set by fetchSession when
// signed in, cleared otherwise and after sign out. Never stored or logged.
let csrfToken: string | null = null

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toUpperCase()
  if (csrfToken && !SAFE_METHODS.has(method)) {
    config.headers.set(CSRF_HEADER, csrfToken)
  }
  return config
})

function redactCsrfHeader(error: unknown): void {
  const headers = (error as { config?: { headers?: { delete?: (name: string) => unknown } & Record<string, unknown> } } | null)
    ?.config?.headers
  if (!headers) return
  if (typeof headers.delete === 'function') headers.delete(CSRF_HEADER)
  else delete headers[CSRF_HEADER]
}

const PERSONAL_KEY_PATH = '/debug-it/personal-key'

// A personal key request's body holds the key (story 5.2): drop it from the
// failed request's config before that config is logged or kept as the
// ApiError cause.
function redactPersonalKeyBody(error: unknown): void {
  const config = (error as { config?: { url?: unknown; data?: unknown } } | null)?.config
  if (!config || typeof config.url !== 'string') return
  if (config.url.split('?')[0]?.replace(/\/+$/, '').endsWith(PERSONAL_KEY_PATH)) {
    delete config.data
  }
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // The failed request's config is part of what gets logged.
    redactCsrfHeader(error)
    redactPersonalKeyBody(error)
    console.error('API Error:', error)

    if (error?.response?.status === 401) {
      console.error('Authentication failed - check GitHub token')
    } else if (error?.response?.status >= 500) {
      console.error('Server error - backend may be down')
    } else if (error?.code === 'ECONNABORTED') {
      console.error('Request timeout - backend may be slow')
    }

    return Promise.reject(toApiError(error))
  }
)

export const fetchSettings = async (): Promise<BackendSettings> => {
  const response = await api.get<BackendSettings>('/settings')
  return response.data
}

export const fetchRunners = async (): Promise<Runner[]> => {
  const response = await api.get<Runner[]>('/runners')
  return response.data
}

export const fetchScaleSets = async (): Promise<ScaleSet[]> => {
  const response = await api.get<ScaleSet[]>('/scale-sets')
  return response.data
}

export const fetchQueue = async (scaleSet?: string): Promise<QueueResponse> => {
  const response = await api.get<QueueResponse>('/jobs/queue', {
    params: scaleSet ? { scaleSet } : undefined,
  })
  return response.data
}

export const fetchRunningJobs = async (scaleSet?: string): Promise<RunningResponse> => {
  const response = await api.get<RunningResponse>('/jobs/running', {
    params: scaleSet ? { scaleSet } : undefined,
  })
  return response.data
}

export const fetchJobHistory = async (scaleSet?: string, limit?: number): Promise<HistoryJob[]> => {
  const params: Record<string, string | number> = {}
  if (scaleSet) params.scaleSet = scaleSet
  if (limit) params.limit = limit
  const response = await api.get<HistoryJob[]>('/jobs/history', { params })
  return response.data
}

export const fetchAlerts = async (): Promise<AlertsResponse> => {
  const response = await api.get<AlertsResponse>('/alerts')
  return response.data
}

export const fetchAlertSettings = async (): Promise<AlertSettingsResponse> => {
  const response = await api.get<AlertSettingsResponse>('/settings/alerts')
  return response.data
}

export const updateAlertSettings = async (update: AlertSettingsUpdate): Promise<AlertSettingsResponse> => {
  const response = await api.put<AlertSettingsResponse>('/settings/alerts', update)
  return response.data
}

export const resetAlertSettings = async (): Promise<AlertSettingsResponse> => {
  const response = await api.delete<AlertSettingsResponse>('/settings/alerts')
  return response.data
}

export const sendTestAlert = async (): Promise<WebhookStatus> => {
  const response = await api.post<{ webhookStatus: WebhookStatus }>('/settings/alerts/test')
  return response.data.webhookStatus
}

// The session read goes through its own instance, outside the logging
// interceptor above: 404 (Debug it off) and 401 (signed out) are ordinary
// answers here and log nothing.
export const sessionApi = axios.create({
  baseURL: API_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
})

export const signInUrl = `${API_BASE_URL.replace(/\/+$/, '')}/debug-it/sign-in`

function toLoginScope(value: unknown): LoginScope {
  return value === 'whole-dashboard' ? 'whole-dashboard' : 'debug-it-only'
}

function toCredentialsMode(value: unknown): DebugItCredentialsMode {
  return value === 'personal' ? 'personal' : 'organization'
}

export const fetchSession = async (): Promise<DebugItSession> => {
  let response
  try {
    response = await sessionApi.get('/debug-it/session', {
      validateStatus: (status) => status === 200 || status === 401 || status === 404,
    })
  } catch (error) {
    // A failed read says nothing about the session: keep the token, since
    // the page keeps showing the last known answer.
    throw toApiError(error)
  }

  const body = (response.data ?? {}) as Record<string, unknown>
  if (response.status === 404) {
    csrfToken = null
    return { state: 'disabled' }
  }
  if (response.status === 401) {
    csrfToken = null
    return { state: 'signed-out', loginScope: toLoginScope(body.loginScope) }
  }
  if (
    typeof body.githubUserId !== 'number' ||
    typeof body.login !== 'string' ||
    typeof body.csrfToken !== 'string' ||
    body.csrfToken === ''
  ) {
    csrfToken = null
    throw new ApiError('The Debug it session answer could not be read.', { source: 'transport', status: response.status })
  }
  csrfToken = body.csrfToken
  return {
    state: 'signed-in',
    githubUserId: body.githubUserId,
    login: body.login,
    csrfToken: body.csrfToken,
    allowedUser: body.allowedUser === true,
    administrator: body.administrator === true,
    loginScope: toLoginScope(body.loginScope),
    credentialsMode: toCredentialsMode(body.credentialsMode),
  }
}

export const signOut = async (): Promise<void> => {
  await api.post('/debug-it/sign-out')
  csrfToken = null
}

// Debug it settings (administrators only). Each change adds or removes one
// entry and answers the lists as now stored.
export const fetchDebugItSettings = async (): Promise<DebugItSettingsView> => {
  const response = await api.get<DebugItSettingsView>('/debug-it/settings')
  return response.data
}

// Debug it usage of the current UTC month (administrators only, story 3.13).
export const fetchDebugItUsage = async (): Promise<DebugItUsageView> => {
  const response = await api.get<DebugItUsageView>('/debug-it/usage')
  return response.data
}

export const addAllowedRepository = async (repository: string): Promise<DebugItSettingsView> => {
  const response = await api.post<DebugItSettingsView>('/debug-it/settings/repositories', { repository })
  return response.data
}

export const removeAllowedRepository = async (repository: string): Promise<DebugItSettingsView> => {
  const [owner = '', name = ''] = repository.split('/')
  const response = await api.delete<DebugItSettingsView>(
    `/debug-it/settings/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  )
  return response.data
}

export const addAllowedUser = async (login: string): Promise<DebugItSettingsView> => {
  const response = await api.post<DebugItSettingsView>('/debug-it/settings/users', { login })
  return response.data
}

export const removeAllowedUser = async (githubUserId: number): Promise<DebugItSettingsView> => {
  const response = await api.delete<DebugItSettingsView>(`/debug-it/settings/users/${encodeURIComponent(String(githubUserId))}`)
  return response.data
}

// Debug it runs (story 3.11). The start sends no body; the CSRF header comes
// from the request interceptor.
export const fetchDebugItRuns = async (): Promise<DebugItRunsOverview> => {
  const response = await api.get<DebugItRunsOverview>('/debug-it/runs')
  return response.data
}

export const startDebugRun = async (target: HistoryTarget): Promise<DebugRunStart> => {
  const response = await api.post<DebugRunStart>(
    `/debug-it/targets/${encodeURIComponent(target.kind)}/${encodeURIComponent(String(target.id))}/runs`,
  )
  return response.data
}

export const fetchDebugRun = async (runId: string): Promise<DebugRunView> => {
  const response = await api.get<DebugRunView>(`/debug-it/runs/${encodeURIComponent(runId)}`)
  return response.data
}

// Debug run result and feedback (story 3.12). The feedback PUT carries the
// CSRF header from the request interceptor.
export const fetchDebugRunResult = async (runId: string): Promise<DebugRunResultView> => {
  const response = await api.get<DebugRunResultView>(`/debug-it/runs/${encodeURIComponent(runId)}/result`)
  return response.data
}

export const saveDebugRunFeedback = async (runId: string, input: DebugFeedbackInput): Promise<DebugRunResultView> => {
  const response = await api.put<DebugRunResultView>(`/debug-it/runs/${encodeURIComponent(runId)}/feedback`, input)
  return response.data
}

// Open a fix pull request (story 4.3). No body; the CSRF header comes from the
// request interceptor. Each path segment is encoded.
export const openDebugFixPullRequest = async (runId: string, repository: string): Promise<DebugFixPullRequest> => {
  const slash = repository.indexOf('/')
  const owner = slash === -1 ? repository : repository.slice(0, slash)
  const name = slash === -1 ? '' : repository.slice(slash + 1)
  const response = await api.post<DebugFixPullRequest>(
    `/debug-it/runs/${encodeURIComponent(runId)}/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  )
  return response.data
}

// The signed in user's personal Anthropic API key (story 5.2). Only the last
// 4 characters come back. PUT and DELETE carry the CSRF header from the
// request interceptor; a failed request's body is dropped before logging.
function toPersonalKeyStatus(data: unknown): PersonalKeyStatus {
  const body = (data ?? {}) as Record<string, unknown>
  const saved = body.saved === true
  return {
    credentialsMode: toCredentialsMode(body.credentialsMode),
    saved,
    last4: saved && typeof body.last4 === 'string' ? body.last4 : null,
  }
}

export const fetchPersonalKey = async (): Promise<PersonalKeyStatus> => {
  const response = await api.get<PersonalKeyStatus>(PERSONAL_KEY_PATH)
  return toPersonalKeyStatus(response.data)
}

export const savePersonalKey = async (key: string): Promise<PersonalKeyStatus> => {
  const response = await api.put<PersonalKeyStatus>(PERSONAL_KEY_PATH, { key })
  return toPersonalKeyStatus(response.data)
}

export const deletePersonalKey = async (): Promise<PersonalKeyDeleted> => {
  const response = await api.delete<PersonalKeyDeleted>(PERSONAL_KEY_PATH)
  const cancelled = (response.data as { cancelledRuns?: unknown } | undefined)?.cancelledRuns
  return {
    ...toPersonalKeyStatus(response.data),
    cancelledRuns: typeof cancelled === 'number' && Number.isFinite(cancelled) && cancelled > 0 ? cancelled : 0,
  }
}

export default api
