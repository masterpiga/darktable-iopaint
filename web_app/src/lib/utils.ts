import { type ClassValue, clsx } from "clsx"
import { SyntheticEvent } from "react"
import { twMerge } from "tailwind-merge"
import { HistoryEntry, LineGroup, Rect } from "./types"
import { BRUSH_COLOR } from "./const"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function keepGUIAlive() {
  async function getRequest(url = "") {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-cache",
    })
    return response.json()
  }

  const keepAliveServer = () => {
    const url = document.location
    const route = "/flaskwebgui-keep-server-alive"
    getRequest(url + route).then((data) => {
      return data
    })
  }

  const intervalRequest = 3 * 1000
  keepAliveServer()
  setInterval(keepAliveServer, intervalRequest)
}

export function dataURItoBlob(dataURI: string) {
  const mime = dataURI.split(",")[0].split(":")[1].split(";")[0]
  const binary = atob(dataURI.split(",")[1])
  const array = []
  for (let i = 0; i < binary.length; i += 1) {
    array.push(binary.charCodeAt(i))
  }
  return new Blob([new Uint8Array(array)], { type: mime })
}

export function loadImage(image: HTMLImageElement, src: string) {
  return new Promise((resolve, reject) => {
    const initSRC = image.src
    const img = image
    img.onload = resolve
    img.onerror = (err) => {
      img.src = initSRC
      reject(err)
    }
    img.src = src
  })
}

export async function blobToImage(blob: Blob) {
  const dataURL = URL.createObjectURL(blob)
  const newImage = new Image()
  await loadImage(newImage, dataURL)
  return newImage
}

export function canvasToImage(
  canvas: HTMLCanvasElement
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()

    image.addEventListener("load", () => {
      resolve(image)
    })

    image.addEventListener("error", (error) => {
      reject(error)
    })

    image.src = canvas.toDataURL()
  })
}

export function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        resolve(image)
      }
      image.onerror = () => {
        reject("无法加载图像。")
      }
      image.src = reader.result as string
    }
    reader.onerror = () => {
      reject("无法读取文件。")
    }
    reader.readAsDataURL(file)
  })
}

export function srcToFile(src: string, fileName: string, mimeType: string) {
  return fetch(src)
    .then(function (res) {
      return res.arrayBuffer()
    })
    .then(function (buf) {
      return new File([buf], fileName, { type: mimeType })
    })
}

export async function askWritePermission() {
  try {
    // The clipboard-write permission is granted automatically to pages
    // when they are the active tab. So it's not required, but it's more safe.
    const { state } = await navigator.permissions.query({
      name: "clipboard-write" as PermissionName,
    })
    return state === "granted"
  } catch (error) {
    // Browser compatibility / Security error (ONLY HTTPS) ...
    return false
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<any> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (d) => {
      if (d) {
        resolve(d)
      } else {
        reject(new Error("Expected toBlob() to be defined"))
      }
    }, mime)
  )
}

const setToClipboard = async (blob: any) => {
  const data = [new ClipboardItem({ [blob.type]: blob })]
  await navigator.clipboard.write(data)
}

export function isRightClick(ev: SyntheticEvent) {
  const mouseEvent = ev.nativeEvent as MouseEvent
  return mouseEvent.button === 2
}

export function isMidClick(ev: SyntheticEvent) {
  const mouseEvent = ev.nativeEvent as MouseEvent
  return mouseEvent.button === 1
}

export async function copyCanvasImage(canvas: HTMLCanvasElement) {
  const blob = await canvasToBlob(canvas, "image/png")
  try {
    await setToClipboard(blob)
  } catch {
    console.log("Copy image failed!")
  }
}

export function downloadImage(uri: string, name: string) {
  const link = document.createElement("a")
  link.href = uri
  link.download = name

  // this is necessary as link.click() does not work on the latest firefox
  link.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    })
  )

  setTimeout(() => {
    // For Firefox it is necessary to delay revoking the ObjectURL
    // window.URL.revokeObjectURL(base64)
    link.remove()
  }, 100)
}

export function mouseXY(ev: SyntheticEvent) {
    const mouseEvent = ev.nativeEvent as MouseEvent
    // Handle mask drawing coordinate on mobile/tablet devices
    if ('touches' in ev) {
        const rect = (ev.target as HTMLCanvasElement).getBoundingClientRect();
        const touches = ev.touches as (Touch & { target: HTMLCanvasElement })[]
        const touch = touches[0]
        return {
            x: (touch.clientX - rect.x) / rect.width * touch.target.offsetWidth,
            y: (touch.clientY - rect.y) / rect.height * touch.target.offsetHeight,
        }
    }
    return {x: mouseEvent.offsetX, y: mouseEvent.offsetY}
}

export function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: LineGroup,
  color = BRUSH_COLOR
) {
  ctx.strokeStyle = color
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  lines.forEach((line) => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach((pt) => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}

export const generateMask = (
  imageWidth: number,
  imageHeight: number,
  lineGroups: LineGroup[],
  maskImages: HTMLImageElement[] = [],
  lineGroupsColor: string = "white"
): HTMLCanvasElement => {
  const maskCanvas = document.createElement("canvas")
  maskCanvas.width = imageWidth
  maskCanvas.height = imageHeight
  const ctx = maskCanvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve mask canvas")
  }

  maskImages.forEach((maskImage) => {
    ctx.drawImage(maskImage, 0, 0, imageWidth, imageHeight)
  })

  lineGroups.forEach((lineGroup) => {
    drawLines(ctx, lineGroup, lineGroupsColor)
  })

  return maskCanvas
}

export interface ComposeResult {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

// Flatten the first `count` history entries onto the original image.
// The last `rebase` entry below `count` defines the base + dimensions; every
// enabled `patch` after it is drawn on top at its bbox. Mirrors the backend
// `inpaint_result[t:b, l:r] = crop` compositing.
export function composeEntries(
  base: HTMLImageElement | HTMLCanvasElement,
  baseWidth: number,
  baseHeight: number,
  entries: HistoryEntry[],
  count: number
): ComposeResult {
  let startBase: HTMLImageElement | HTMLCanvasElement = base
  let w = baseWidth
  let h = baseHeight
  let startIdx = 0
  for (let i = 0; i < count; i += 1) {
    const e = entries[i]
    if (e.kind === "rebase") {
      startBase = e.canvas
      w = e.width
      h = e.height
      startIdx = i + 1
    }
  }

  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve compose canvas")
  }
  ctx.drawImage(startBase, 0, 0, w, h)
  for (let i = startIdx; i < count; i += 1) {
    const e = entries[i]
    if (e.kind === "patch" && e.enabled) {
      ctx.drawImage(e.canvas, e.bbox.x, e.bbox.y)
    }
  }
  return { canvas, width: w, height: h }
}

// Bounding box of non-transparent pixels in a mask canvas, padded and clamped.
export function bboxFromMaskCanvas(
  maskCanvas: HTMLCanvasElement,
  pad = 0
): Rect | null {
  const { width, height } = maskCanvas
  const ctx = maskCanvas.getContext("2d")
  if (!ctx) {
    return null
  }
  const { data } = ctx.getImageData(0, 0, width, height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) {
    return null
  }
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// Crop a rectangular region out of an image/canvas into a new canvas.
export function cropToCanvas(
  src: HTMLImageElement | HTMLCanvasElement,
  bbox: Rect
): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = bbox.width
  canvas.height = bbox.height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve crop canvas")
  }
  ctx.drawImage(
    src,
    bbox.x,
    bbox.y,
    bbox.width,
    bbox.height,
    0,
    0,
    bbox.width,
    bbox.height
  )
  return canvas
}

// Cheap bounding box of the brush strokes (origin + brush radius), for the live
// tile-grid preview while drawing. The actual run uses the full rendered mask.
export function bboxFromLineGroup(lineGroup: LineGroup): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  lineGroup.forEach((line) => {
    const r = (line.size ?? 0) / 2
    line.pts.forEach((p) => {
      if (p.x - r < minX) minX = p.x - r
      if (p.x + r > maxX) maxX = p.x + r
      if (p.y - r < minY) minY = p.y - r
      if (p.y + r > maxY) maxY = p.y + r
    })
  })
  if (maxX === -Infinity) {
    return null
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export interface TileOptions {
  tileSize: number
  overlap: number
  contextPad: number
  imageW: number
  imageH: number
}

// Lay out a grid of overlapping `tileSize` windows covering the (context-padded)
// mask bounding box. Tile origins are clamped so every tile stays inside the
// image; edge clamping can collapse origins, which are de-duplicated.
export function computeTiles(maskBbox: Rect, opts: TileOptions): Rect[] {
  const { tileSize, overlap, contextPad, imageW, imageH } = opts
  const step = Math.max(1, tileSize - overlap)
  const tw = Math.min(tileSize, imageW)
  const th = Math.min(tileSize, imageH)

  const ax = Math.max(0, maskBbox.x - contextPad)
  const ay = Math.max(0, maskBbox.y - contextPad)
  const ax2 = Math.min(imageW, maskBbox.x + maskBbox.width + contextPad)
  const ay2 = Math.min(imageH, maskBbox.y + maskBbox.height + contextPad)

  const origins = (start: number, end: number, tileDim: number, max: number) => {
    const out: number[] = []
    for (let p = start; ; p += step) {
      out.push(Math.max(0, Math.min(p, max - tileDim)))
      if (p + tileDim >= end) break
    }
    return Array.from(new Set(out))
  }

  const xs = origins(ax, ax2, tw, imageW)
  const ys = origins(ay, ay2, th, imageH)
  const tiles: Rect[] = []
  ys.forEach((y) => {
    xs.forEach((x) => {
      tiles.push({ x, y, width: tw, height: th })
    })
  })
  return tiles
}

// Whether any masked (non-transparent) pixel falls inside `rect`.
export function maskIntersectsRect(
  maskCanvas: HTMLCanvasElement,
  rect: Rect
): boolean {
  const ctx = maskCanvas.getContext("2d")
  if (!ctx) {
    return false
  }
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const w = Math.min(maskCanvas.width - x, Math.ceil(rect.width))
  const h = Math.min(maskCanvas.height - y, Math.ceil(rect.height))
  if (w <= 0 || h <= 0) {
    return false
  }
  const { data } = ctx.getImageData(x, y, w, h)
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      return true
    }
  }
  return false
}

// Copy of `maskCanvas` with everything outside `rect` cleared. This is the
// model-agnostic way to confine a tile's processing to its window.
export function clipMaskToRect(
  maskCanvas: HTMLCanvasElement,
  rect: Rect
): HTMLCanvasElement {
  const out = document.createElement("canvas")
  out.width = maskCanvas.width
  out.height = maskCanvas.height
  const ctx = out.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve clip canvas")
  }
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()
  ctx.drawImage(maskCanvas, 0, 0)
  return out
}

// Fade a tile patch's alpha to 0 over `feather` px at the given inner edges, so
// overlapping tiles cross-fade instead of showing a hard rectangular seam. Edges
// at the image border are left fully opaque so border tiles still cover.
export function featherPatch(
  src: HTMLCanvasElement,
  feather: number,
  edges: { left: boolean; top: boolean; right: boolean; bottom: boolean }
): HTMLCanvasElement {
  const w = src.width
  const h = src.height
  const out = document.createElement("canvas")
  out.width = w
  out.height = h
  const ctx = out.getContext("2d")
  if (!ctx) {
    throw new Error("could not retrieve feather canvas")
  }
  ctx.drawImage(src, 0, 0)
  const f = Math.floor(Math.min(feather, w / 2, h / 2))
  if (f <= 0) {
    return out
  }

  // Build an alpha mask: opaque interior, ramping to transparent at each
  // feathered edge. Successive destination-in fills multiply the alpha, so
  // corners ramp correctly.
  const mask = document.createElement("canvas")
  mask.width = w
  mask.height = h
  const mctx = mask.getContext("2d")
  if (!mctx) {
    return out
  }
  mctx.fillStyle = "#fff"
  mctx.fillRect(0, 0, w, h)
  mctx.globalCompositeOperation = "destination-in"
  const transparent = "rgba(0,0,0,0)"
  const opaque = "rgba(0,0,0,1)"
  const ramp = (
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => {
    const g = mctx.createLinearGradient(x0, y0, x1, y1)
    g.addColorStop(0, transparent)
    g.addColorStop(1, opaque)
    mctx.fillStyle = g
    mctx.fillRect(0, 0, w, h) // gradient clamps to opaque beyond `feather`
  }
  if (edges.left) ramp(0, 0, f, 0)
  if (edges.right) ramp(w, 0, w - f, 0)
  if (edges.top) ramp(0, 0, 0, f)
  if (edges.bottom) ramp(0, h, 0, h - f)

  ctx.globalCompositeOperation = "destination-in"
  ctx.drawImage(mask, 0, 0)
  return out
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(rect.x, width))
  const y = Math.max(0, Math.min(rect.y, height))
  const w = Math.max(0, Math.min(rect.width, width - x))
  const h = Math.max(0, Math.min(rect.height, height - y))
  return { x, y, width: w, height: h }
}

export function canvasToFile(
  canvas: HTMLCanvasElement,
  fileName: string,
  mimeType: string
): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(new File([blob], fileName, { type: mimeType }))
      } else {
        reject(new Error("Expected toBlob() to be defined"))
      }
    }, mimeType)
  })
}

export const convertToBase64 = (fileOrBlob: File | Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const base64String = event.target?.result as string
      resolve(base64String)
    }
    reader.onerror = (error) => {
      reject(error)
    }
    reader.readAsDataURL(fileOrBlob)
  })
}
