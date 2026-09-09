import axios from 'axios'
import type {
  BackendSettings,
  HistoryJob,
  QueueResponse,
  Runner,
  RunningResponse,
  ScaleSet,
} from '../types/api'
import { toApiError } from './apiError'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
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

export default api
