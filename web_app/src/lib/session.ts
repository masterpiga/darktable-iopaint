// Persists the in-progress edit session (source file + committed history) to
// IndexedDB so a transient failure that forces a browser reload doesn't lose
// work — on reload the image and its full edit history are restored silently.
//
// IndexedDB (not the localStorage `persist` used for settings) because a
// session can be tens of MB: the source image plus a full-res canvas per
// rebase and a bbox-sized canvas per patch. IndexedDB stores Blobs natively,
// so images round-trip without base64. The `originalImage` is not stored on its
// own — it's re-decoded from the persisted source file on restore.

import { HistoryEntry, LineGroup, PatchEntry, Rect } from "./types"
import { blobToImage } from "./utils"

const DB_NAME = "iopaint-session"
const STORE = "session"
const KEY = "current"

type SerializedEntry =
  | {
      kind: "patch"
      id: string
      enabled: boolean
      bbox: Rect
      canvasBlob: Blob
      lineGroup: LineGroup
      extraMaskBlobs: Blob[]
      batchId?: string
      label: string
      settings: PatchEntry["settings"]
      cropper: PatchEntry["cropper"]
    }
  | {
      kind: "rebase"
      id: string
      enabled: true
      canvasBlob: Blob
      width: number
      height: number
      label: string
    }

export type SerializedSession = {
  fileBlob: Blob
  fileName: string
  fileType: string
  // Identity used to match a persisted session against a freshly loaded file
  // (so re-opening the same image restores its edits, a different one starts
  // fresh). name + size is enough in practice.
  fileSize: number
  entries: SerializedEntry[]
  headIndex: number
}

// --- IndexedDB single-record store ----------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const req = run(transaction.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => db.close()
      })
  )
}

async function putSession(record: SerializedSession): Promise<void> {
  await tx("readwrite", (s) => s.put(record, KEY))
}

export async function loadSession(): Promise<SerializedSession | null> {
  try {
    const record = await tx<SerializedSession | undefined>("readonly", (s) =>
      s.get(KEY)
    )
    return record ?? null
  } catch (e) {
    console.error("loadSession failed", e)
    return null
  }
}

export async function clearSession(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(KEY))
  } catch (e) {
    console.error("clearSession failed", e)
  }
}

// --- canvas/image <-> Blob -------------------------------------------------

// Encoded-blob caches keyed on the source element. Patch/rebase canvases (and
// the segmentation-mask images they reference) are immutable once created — only
// the `enabled` flag changes afterward — so caching by element identity lets a
// debounced autosave skip re-encoding unchanged entries, which keeps saving a
// 19-tile batch cheap while toggling patches. WeakMap so entries dropped from
// history are collected automatically.
const canvasBlobCache = new WeakMap<HTMLCanvasElement, Blob>()
const imageBlobCache = new WeakMap<HTMLImageElement, Blob>()

// PNG to preserve the alpha that patch compositing (composeEntries) relies on.
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const cached = canvasBlobCache.get(canvas)
  if (cached) {
    return Promise.resolve(cached)
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"))
        return
      }
      canvasBlobCache.set(canvas, blob)
      resolve(blob)
    }, "image/png")
  })
}

async function imageToBlob(image: HTMLImageElement): Promise<Blob> {
  const cached = imageBlobCache.get(image)
  if (cached) {
    return cached
  }
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not get 2d context")
  }
  ctx.drawImage(image, 0, 0)
  const blob = await canvasToBlob(canvas)
  imageBlobCache.set(image, blob)
  return blob
}

// Decode a blob back into a fresh canvas sized to the encoded image (entries are
// typed HTMLCanvasElement and composeEntries needs real canvases).
async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const image = await blobToImage(blob)
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not get 2d context")
  }
  ctx.drawImage(image, 0, 0)
  // Prime the cache so the next autosave reuses this blob instead of re-encoding.
  canvasBlobCache.set(canvas, blob)
  return canvas
}

// --- editor <-> serialized session ----------------------------------------

export async function serializeEditor(
  file: File,
  entries: HistoryEntry[],
  headIndex: number
): Promise<SerializedSession> {
  const serialized: SerializedEntry[] = await Promise.all(
    entries.map(async (entry): Promise<SerializedEntry> => {
      if (entry.kind === "rebase") {
        return {
          kind: "rebase",
          id: entry.id,
          enabled: true,
          canvasBlob: await canvasToBlob(entry.canvas),
          width: entry.width,
          height: entry.height,
          label: entry.label,
        }
      }
      return {
        kind: "patch",
        id: entry.id,
        enabled: entry.enabled,
        bbox: entry.bbox,
        canvasBlob: await canvasToBlob(entry.canvas),
        lineGroup: entry.lineGroup,
        extraMaskBlobs: await Promise.all(entry.extraMasks.map(imageToBlob)),
        batchId: entry.batchId,
        label: entry.label,
        settings: entry.settings,
        cropper: entry.cropper,
      }
    })
  )
  return {
    fileBlob: file,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    entries: serialized,
    headIndex,
  }
}

export type RestoredSession = {
  file: File
  entries: HistoryEntry[]
  headIndex: number
}

export async function deserializeEditor(
  record: SerializedSession
): Promise<RestoredSession> {
  const file = new File([record.fileBlob], record.fileName, {
    type: record.fileType,
  })
  const entries: HistoryEntry[] = await Promise.all(
    record.entries.map(async (entry): Promise<HistoryEntry> => {
      if (entry.kind === "rebase") {
        return {
          kind: "rebase",
          id: entry.id,
          enabled: true,
          canvas: await blobToCanvas(entry.canvasBlob),
          width: entry.width,
          height: entry.height,
          label: entry.label,
        }
      }
      return {
        kind: "patch",
        id: entry.id,
        enabled: entry.enabled,
        bbox: entry.bbox,
        canvas: await blobToCanvas(entry.canvasBlob),
        lineGroup: entry.lineGroup,
        extraMasks: await Promise.all(entry.extraMaskBlobs.map(blobToImage)),
        batchId: entry.batchId,
        label: entry.label,
        settings: entry.settings,
        cropper: entry.cropper,
      }
    })
  )
  return { file, entries, headIndex: record.headIndex }
}

export async function saveSession(
  file: File,
  entries: HistoryEntry[],
  headIndex: number
): Promise<void> {
  try {
    const record = await serializeEditor(file, entries, headIndex)
    await putSession(record)
  } catch (e) {
    console.error("saveSession failed", e)
  }
}
