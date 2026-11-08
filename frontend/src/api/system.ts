import { SystemStatusResponseSchema } from '@opencode-manager/shared/schemas'
import { API_BASE_URL } from '@/config'
import { fetchWrapper } from './fetchWrapper'

export async function fetchSystemStatus() {
  return SystemStatusResponseSchema.parse(await fetchWrapper(`${API_BASE_URL}/api/system/status`))
}
