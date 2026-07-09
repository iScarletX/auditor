import type { ReviewReport } from '../../types/reviewReport.types'

const DB_NAME = 'butler-local'
const DB_VERSION = 1

export interface ReviewHistoryRecord {
  id: string
  createdAt: string
  title: string
  targetSp: string
  scenarioHint?: string
  report: ReviewReport
}

export interface UserSkillRecord {
  id: string
  createdAt: string
  content: string
}

export interface DraftRevisionRecord {
  id: string
  createdAt: string
  issueId: string
  before: string
  after: string
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function openButlerDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('reviews')) {
        db.createObjectStore('reviews', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('userSkills')) {
        db.createObjectStore('userSkills', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('secrets')) {
        db.createObjectStore('secrets', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('draftRevisions')) {
        db.createObjectStore('draftRevisions', { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveReviewRecord(record: ReviewHistoryRecord) {
  const db = await openButlerDb()
  const transaction = db.transaction('reviews', 'readwrite')
  transaction.objectStore('reviews').put(record)
  await transactionDone(transaction)
  db.close()
}

export async function listReviewRecords(): Promise<ReviewHistoryRecord[]> {
  const db = await openButlerDb()
  const transaction = db.transaction('reviews', 'readonly')
  const records = await requestToPromise<ReviewHistoryRecord[]>(
    transaction.objectStore('reviews').getAll(),
  )
  db.close()
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteReviewRecord(id: string) {
  const db = await openButlerDb()
  const transaction = db.transaction('reviews', 'readwrite')
  transaction.objectStore('reviews').delete(id)
  await transactionDone(transaction)
  db.close()
}

export async function saveUserSkill(record: UserSkillRecord) {
  const db = await openButlerDb()
  const transaction = db.transaction('userSkills', 'readwrite')
  transaction.objectStore('userSkills').put(record)
  await transactionDone(transaction)
  db.close()
}

export async function listUserSkills(): Promise<UserSkillRecord[]> {
  const db = await openButlerDb()
  const transaction = db.transaction('userSkills', 'readonly')
  const records = await requestToPromise<UserSkillRecord[]>(
    transaction.objectStore('userSkills').getAll(),
  )
  db.close()
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function saveSecret<T>(id: string, value: T) {
  const db = await openButlerDb()
  const transaction = db.transaction('secrets', 'readwrite')
  transaction.objectStore('secrets').put({ id, value })
  await transactionDone(transaction)
  db.close()
}

export async function loadSecret<T>(id: string): Promise<T | null> {
  const db = await openButlerDb()
  const transaction = db.transaction('secrets', 'readonly')
  const record = await requestToPromise<{ id: string; value: T } | undefined>(
    transaction.objectStore('secrets').get(id),
  )
  db.close()
  return record?.value ?? null
}

export async function saveDraftRevision(record: DraftRevisionRecord) {
  const db = await openButlerDb()
  const transaction = db.transaction('draftRevisions', 'readwrite')
  transaction.objectStore('draftRevisions').put(record)
  await transactionDone(transaction)
  db.close()
}
