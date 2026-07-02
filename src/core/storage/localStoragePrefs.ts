import type { ModelConfig } from '../../types/reviewReport.types'

const MODEL_PREFS_KEY = 'butler:model-prefs'
const ENCRYPTED_API_KEY = 'butler:encrypted-api-key'

export interface EncryptedApiKeyRecord {
  iv: string
  ciphertext: string
  updatedAt: string
  mask?: string
}

export function saveModelPrefs(models: ModelConfig[]) {
  const portable = models.map(({ id, label, provider, baseUrl, modelId, selected }) => ({
    id,
    label,
    provider,
    baseUrl,
    modelId,
    selected,
  }))
  localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify(portable))
}

export function loadModelPrefs(): ModelConfig[] | null {
  const raw = localStorage.getItem(MODEL_PREFS_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ModelConfig[]
  } catch {
    localStorage.removeItem(MODEL_PREFS_KEY)
    return null
  }
}

export function saveEncryptedApiKeyRecord(record: EncryptedApiKeyRecord) {
  localStorage.setItem(ENCRYPTED_API_KEY, JSON.stringify(record))
}

export function loadEncryptedApiKeyRecord(): EncryptedApiKeyRecord | null {
  const raw = localStorage.getItem(ENCRYPTED_API_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as EncryptedApiKeyRecord
  } catch {
    localStorage.removeItem(ENCRYPTED_API_KEY)
    return null
  }
}

export function getStoredApiKeyMask() {
  return loadEncryptedApiKeyRecord()?.mask ?? '••••••••••••'
}

export function hasStoredEncryptedApiKey() {
  return Boolean(localStorage.getItem(ENCRYPTED_API_KEY))
}

export function clearStoredEncryptedApiKey() {
  localStorage.removeItem(ENCRYPTED_API_KEY)
}
