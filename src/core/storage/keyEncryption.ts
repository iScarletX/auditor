import {
  loadEncryptedApiKeyRecord,
  saveEncryptedApiKeyRecord,
} from './localStoragePrefs'
import { loadSecret, saveSecret } from './indexedDbStore'

const CRYPTO_KEY_ID = 'api-key-encryption-key'

function toBase64(bytes: ArrayBuffer | Uint8Array) {
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  uint8.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  const existing = await loadSecret<CryptoKey>(CRYPTO_KEY_ID)
  if (existing) return existing

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  await saveSecret(CRYPTO_KEY_ID, key)
  return key
}

function maskApiKey(apiKey: string) {
  if (apiKey.length <= 8) return '••••••••'
  return `${apiKey.slice(0, 5)}••••••••${apiKey.slice(-4)}`
}

export async function encryptAndStoreApiKey(apiKey: string) {
  const key = await getOrCreateEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(apiKey)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  saveEncryptedApiKeyRecord({
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    updatedAt: new Date().toISOString(),
    mask: maskApiKey(apiKey),
  })
}

export async function loadDecryptedApiKey(): Promise<string | null> {
  const record = loadEncryptedApiKeyRecord()
  if (!record) return null
  const key = await getOrCreateEncryptionKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) },
    key,
    fromBase64(record.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
