import { persist } from "zustand/middleware"
import { shallow } from "zustand/shallow"
import { immer } from "zustand/middleware/immer"
import { castDraft } from "immer"
import { createWithEqualityFn } from "zustand/traditional"
import {
  AdjustMaskOperate,
  CV2Flag,
  ExtenderDirection,
  HistoryEntry,
  LDMSampler,
  Line,
  LineGroup,
  ModelInfo,
  PluginParams,
  Point,
  PowerPaintTask,
  Rect,
  ServerConfig,
  Size,
  SortBy,
  SortOrder,
} from "./types"
import {
  BRUSH_COLOR,
  DEFAULT_BRUSH_SIZE,
  DEFAULT_NEGATIVE_PROMPT,
  MAX_BRUSH_SIZE,
  MODEL_TYPE_INPAINT,
  PAINT_BY_EXAMPLE,
} from "./const"
import {
  bboxFromMaskCanvas,
  blobToImage,
  canvasToFile,
  canvasToImage,
  clampRect,
  clipMaskToRect,
  composeEntries,
  computeTiles,
  cropToCanvas,
  dataURItoBlob,
  featherPatch,
  fileToImage,
  generateMask,
  loadImage,
  maskIntersectsRect,
} from "./utils"
import inpaint, {
  getGenInfo,
  getPresets,
  postAdjustMask,
  runPlugin,
  savePresets,
} from "./api"
import { toast } from "@/components/ui/use-toast"

type FileManagerState = {
  sortBy: SortBy
  sortOrder: SortOrder
  layout: "rows" | "masonry"
  searchText: string
  inputDirectory: string
  outputDirectory: string
}

type CropperState = {
  x: number
  y: number
  width: number
  height: number
}

export type Settings = {
  model: ModelInfo
  enableDownloadMask: boolean
  enableManualInpainting: boolean
  enableUploadMask: boolean
  enableAutoExtractPrompt: boolean
  showCropper: boolean
  showExtender: boolean
  extenderDirection: ExtenderDirection

  // Patch fill (auto-tile): cover a large masked area with a sliding window of
  // overlapping patches, processed sequentially.
  patchFill: boolean
  patchSize: number
  patchOverlap: number
  patchContextPad: number

  // For LDM
  ldmSteps: number
  ldmSampler: LDMSampler

  // For ZITS
  zitsWireframe: boolean

  // For OpenCV2
  cv2Radius: number
  cv2Flag: CV2Flag

  // For Diffusion moel
  prompt: string
  negativePrompt: string
  seed: number
  seedFixed: boolean

  // For SD
  sdMaskBlur: number
  sdStrength: number
  sdSteps: number
  sdGuidanceScale: number
  sdSampler: string
  sdMatchHistograms: boolean
  sdScale: number

  // Pix2Pix
  p2pImageGuidanceScale: number

  // ControlNet
  enableControlnet: boolean
  controlnetConditioningScale: number
  controlnetMethod: string

  // BrushNet
  enableBrushNet: boolean
  brushnetMethod: string
  brushnetConditioningScale: number

  enableLCMLora: boolean

  // PowerPaint
  enablePowerPaintV2: boolean
  powerpaintTask: PowerPaintTask

  // AdjustMask
  adjustMaskKernelSize: number
}

// A named snapshot of the full diffusion settings (model included), saved by the
// user and loadable from the top-bar Presets dropdown. `cropper` stores the
// cropper size, which lives outside `settings` (in cropperState); optional so
// presets saved before it was captured still load.
export type Preset = {
  name: string
  settings: Settings
  cropper?: { width: number; height: number }
}

type InteractiveSegState = {
  isInteractiveSeg: boolean
  tmpInteractiveSegMask: HTMLImageElement | null
  clicks: number[][]
}

type EditorState = {
  baseBrushSize: number
  brushSizeScale: number

  // Decoded original image; base for compositing the history entries.
  originalImage: HTMLImageElement | null
  // Ordered, toggleable edit history. Entries with index < headIndex are
  // "in the timeline" (undo); entries >= headIndex are undone (redoable).
  entries: HistoryEntry[]
  headIndex: number

  lastLineGroup: LineGroup
  curLineGroup: LineGroup

  // mask from interactive-seg or other segmentation models
  extraMasks: HTMLImageElement[]
  prevExtraMasks: HTMLImageElement[]

  temporaryMasks: HTMLImageElement[]
  // redo for manual single strokes
  redoCurLines: Line[]
}

type AppState = {
  file: File | null
  paintByExampleFile: File | null
  customMask: File | null
  imageHeight: number
  imageWidth: number
  isInpainting: boolean
  isPluginRunning: boolean
  isAdjustingMask: boolean
  // Progress of an in-flight patch-fill run, null when idle.
  patchProgress: { total: number; done: number } | null
  windowSize: Size
  editorState: EditorState
  disableShortCuts: boolean

  interactiveSegState: InteractiveSegState
  fileManagerState: FileManagerState

  cropperState: CropperState
  extenderState: CropperState
  isCropperExtenderResizing: boolean

  serverConfig: ServerConfig

  settings: Settings

  presets: Preset[]
}

type AppAction = {
  updateAppState: (newState: Partial<AppState>) => void
  setFile: (file: File) => Promise<void>
  setCustomFile: (file: File) => void
  setIsInpainting: (newValue: boolean) => void
  getIsProcessing: () => boolean
  setBaseBrushSize: (newValue: number) => void
  decreaseBaseBrushSize: () => void
  increaseBaseBrushSize: () => void
  getBrushSize: () => number
  setImageSize: (width: number, height: number) => void

  isSD: () => boolean

  setCropperX: (newValue: number) => void
  setCropperY: (newValue: number) => void
  setCropperWidth: (newValue: number) => void
  setCropperHeight: (newValue: number) => void
  setCropperSize: (size: number) => void
  setCropperDimensions: (width: number, height: number) => void

  setExtenderX: (newValue: number) => void
  setExtenderY: (newValue: number) => void
  setExtenderWidth: (newValue: number) => void
  setExtenderHeight: (newValue: number) => void

  setIsCropperExtenderResizing: (newValue: boolean) => void

  setPresets: (presets: Preset[]) => void
  loadPresets: () => Promise<void>
  savePreset: (name: string) => Promise<void>
  deletePreset: (name: string) => Promise<void>

  updateExtenderDirection: (newValue: ExtenderDirection) => void
  resetExtender: (width: number, height: number) => void
  updateExtenderByBuiltIn: (direction: ExtenderDirection, scale: number) => void

  setServerConfig: (newValue: ServerConfig) => void
  setSeed: (newValue: number) => void
  updateSettings: (newSettings: Partial<Settings>) => void

  // 互斥
  updateEnablePowerPaintV2: (newValue: boolean) => void
  updateEnableBrushNet: (newValue: boolean) => void
  updateEnableControlnet: (newValue: boolean) => void
  updateLCMLora: (newValue: boolean) => void

  setModel: (newModel: ModelInfo) => void
  updateFileManagerState: (newState: Partial<FileManagerState>) => void
  updateInteractiveSegState: (newState: Partial<InteractiveSegState>) => void
  resetInteractiveSegState: () => void
  handleInteractiveSegAccept: () => void
  handleFileManagerMaskSelect: (blob: Blob) => Promise<void>
  showPromptInput: () => boolean

  runInpainting: () => Promise<void>
  runAutoTile: () => Promise<void>
  showPrevMask: () => Promise<void>
  hidePrevMask: () => void
  runRenderablePlugin: (
    genMask: boolean,
    pluginName: string,
    params?: PluginParams
  ) => Promise<void>

  // EditorState
  getCurrentTargetFile: () => Promise<File>
  getComposedCanvas: () => HTMLCanvasElement | null
  hasActiveEntry: () => boolean
  ensureOriginalImage: () => Promise<HTMLImageElement | null>
  togglePatch: (id: string) => void
  setBatchEnabled: (batchId: string, enabled: boolean) => void
  updateEditorState: (newState: Partial<EditorState>) => void
  runMannually: () => boolean
  handleCanvasMouseDown: (point: Point) => void
  handleCanvasMouseMove: (point: Point) => void
  cleanCurLineGroup: () => void
  resetRedoState: () => void
  undo: () => void
  redo: () => void
  undoDisabled: () => boolean
  redoDisabled: () => boolean

  adjustMask: (operate: AdjustMaskOperate) => Promise<void>
  clearMask: () => void
}

const defaultValues: AppState = {
  file: null,
  paintByExampleFile: null,
  customMask: null,
  imageHeight: 0,
  imageWidth: 0,
  isInpainting: false,
  isPluginRunning: false,
  isAdjustingMask: false,
  patchProgress: null,
  disableShortCuts: false,

  windowSize: {
    height: 600,
    width: 800,
  },
  editorState: {
    baseBrushSize: DEFAULT_BRUSH_SIZE,
    brushSizeScale: 1,
    originalImage: null,
    entries: [],
    headIndex: 0,
    extraMasks: [],
    prevExtraMasks: [],
    temporaryMasks: [],
    lastLineGroup: [],
    curLineGroup: [],
    redoCurLines: [],
  },

  interactiveSegState: {
    isInteractiveSeg: false,
    tmpInteractiveSegMask: null,
    clicks: [],
  },

  cropperState: {
    x: 0,
    y: 0,
    width: 512,
    height: 512,
  },
  extenderState: {
    x: 0,
    y: 0,
    width: 512,
    height: 512,
  },
  isCropperExtenderResizing: false,

  fileManagerState: {
    sortBy: SortBy.CTIME,
    sortOrder: SortOrder.DESCENDING,
    layout: "masonry",
    searchText: "",
    inputDirectory: "",
    outputDirectory: "",
  },
  serverConfig: {
    plugins: [],
    modelInfos: [],
    removeBGModel: "briaai/RMBG-1.4",
    removeBGModels: [],
    realesrganModel: "realesr-general-x4v3",
    realesrganModels: [],
    interactiveSegModel: "vit_b",
    interactiveSegModels: [],
    enableFileManager: false,
    enableAutoSaving: false,
    enableControlnet: false,
    controlnetMethod: "lllyasviel/control_v11p_sd15_canny",
    disableModelSwitch: false,
    isDesktop: false,
    samplers: ["DPM++ 2M SDE Karras"],
  },
  settings: {
    model: {
      name: "lama",
      path: "lama",
      model_type: "inpaint",
      support_controlnet: false,
      support_brushnet: false,
      support_strength: false,
      support_outpainting: false,
      support_powerpaint_v2: false,
      controlnets: [],
      brushnets: [],
      support_lcm_lora: false,
      is_single_file_diffusers: false,
      need_prompt: false,
    },
    showCropper: false,
    showExtender: false,
    extenderDirection: ExtenderDirection.xy,
    patchFill: false,
    patchSize: 512,
    patchOverlap: 128,
    patchContextPad: 32,
    enableDownloadMask: false,
    enableManualInpainting: false,
    enableUploadMask: false,
    enableAutoExtractPrompt: true,
    ldmSteps: 30,
    ldmSampler: LDMSampler.ddim,
    zitsWireframe: true,
    cv2Radius: 5,
    cv2Flag: CV2Flag.INPAINT_NS,
    prompt: "",
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    seed: 42,
    seedFixed: false,
    sdMaskBlur: 12,
    sdStrength: 1.0,
    sdSteps: 50,
    sdGuidanceScale: 7.5,
    sdSampler: "DPM++ 2M",
    sdMatchHistograms: false,
    sdScale: 1.0,
    p2pImageGuidanceScale: 1.5,
    enableControlnet: false,
    controlnetMethod: "lllyasviel/control_v11p_sd15_canny",
    controlnetConditioningScale: 0.4,
    enableBrushNet: false,
    brushnetMethod: "random_mask",
    brushnetConditioningScale: 1.0,
    enableLCMLora: false,
    enablePowerPaintV2: false,
    powerpaintTask: PowerPaintTask.text_guided,
    adjustMaskKernelSize: 12,
  },

  presets: [],
}

let entrySeq = 0
function genId(): string {
  entrySeq += 1
  return `e${Date.now().toString(36)}-${entrySeq}`
}

export const useStore = createWithEqualityFn<AppState & AppAction>()(
  persist(
    immer((set, get) => ({
      ...defaultValues,

      showPrevMask: async () => {
        if (get().settings.showExtender) {
          return
        }
        const { lastLineGroup, curLineGroup, prevExtraMasks, extraMasks } =
          get().editorState
        if (curLineGroup.length !== 0 || extraMasks.length !== 0) {
          return
        }
        const { imageWidth, imageHeight } = get()

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [lastLineGroup],
          prevExtraMasks,
          BRUSH_COLOR
        )
        try {
          const maskImage = await canvasToImage(maskCanvas)
          set((state) => {
            state.editorState.temporaryMasks.push(castDraft(maskImage))
          })
        } catch (e) {
          console.error(e)
          return
        }
      },
      hidePrevMask: () => {
        set((state) => {
          state.editorState.temporaryMasks = []
        })
      },

      getComposedCanvas: (): HTMLCanvasElement | null => {
        const { originalImage, entries, headIndex } = get().editorState
        if (!originalImage) {
          return null
        }
        const { canvas } = composeEntries(
          originalImage,
          originalImage.naturalWidth,
          originalImage.naturalHeight,
          entries,
          headIndex
        )
        return canvas
      },

      hasActiveEntry: (): boolean => {
        return get().editorState.headIndex > 0
      },

      // Returns the decoded original image, decoding+caching it on demand so the
      // history compositing (and per-tile feed-forward) can never silently fall
      // back to the raw file.
      ensureOriginalImage: async (): Promise<HTMLImageElement | null> => {
        const existing = get().editorState.originalImage
        if (existing) {
          return existing
        }
        const file = get().file
        if (!file) {
          return null
        }
        try {
          const image = await fileToImage(file)
          set((state) => {
            state.editorState.originalImage = castDraft(image)
          })
          return image
        } catch (e) {
          console.error(e)
          return null
        }
      },

      togglePatch: (id: string) => {
        set((state) => {
          const entry = state.editorState.entries.find((e) => e.id === id)
          if (entry && entry.kind === "patch") {
            entry.enabled = !entry.enabled
          }
        })
      },

      setBatchEnabled: (batchId: string, enabled: boolean) => {
        set((state) => {
          state.editorState.entries.forEach((entry) => {
            if (entry.kind === "patch" && entry.batchId === batchId) {
              entry.enabled = enabled
            }
          })
        })
      },

      getCurrentTargetFile: async (): Promise<File> => {
        const file = get().file! // 一定是在 file 加载了以后才可能调用这个函数
        if (get().editorState.headIndex === 0) {
          return file
        }
        const canvas = get().getComposedCanvas()
        if (!canvas) {
          return file
        }
        return canvasToFile(canvas, file.name, file.type)
      },

      runInpainting: async () => {
        const {
          isInpainting,
          file,
          paintByExampleFile,
          imageWidth,
          imageHeight,
          settings,
          cropperState,
          extenderState,
        } = get()
        if (isInpainting || file === null) {
          return
        }
        if (
          get().settings.model.support_outpainting &&
          settings.showExtender &&
          extenderState.x === 0 &&
          extenderState.y === 0 &&
          extenderState.height === imageHeight &&
          extenderState.width === imageWidth
        ) {
          return
        }

        // Patch-fill: tile the whole masked area instead of a single pass.
        if (
          settings.patchFill &&
          !settings.showExtender &&
          (get().editorState.curLineGroup.length > 0 ||
            get().editorState.extraMasks.length > 0)
        ) {
          await get().runAutoTile()
          return
        }

        const {
          lastLineGroup,
          curLineGroup,
          entries,
          headIndex,
          prevExtraMasks,
          extraMasks,
        } = get().editorState
        const originalImage = await get().ensureOriginalImage()

        const useLastLineGroup =
          curLineGroup.length === 0 &&
          extraMasks.length === 0 &&
          !settings.showExtender

        // useLastLineGroup:
        // 1. re-use the previous mask
        // 2. re-roll the most recent patch in place (rather than stacking)
        let maskImages: HTMLImageElement[] = []
        let maskLineGroup: LineGroup = []
        if (useLastLineGroup === true) {
          maskLineGroup = lastLineGroup
          maskImages = prevExtraMasks
        } else {
          maskLineGroup = curLineGroup
          maskImages = extraMasks
        }

        if (
          maskLineGroup.length === 0 &&
          maskImages.length === 0 &&
          !settings.showExtender
        ) {
          toast({
            variant: "destructive",
            description: "Please draw mask on picture",
          })
          return
        }

        const lastEntry = entries[headIndex - 1]
        const isReroll =
          useLastLineGroup &&
          lastEntry !== undefined &&
          lastEntry.kind === "patch"
        // The re-roll re-processes the region beneath the last patch, so its
        // input is the composite excluding that patch.
        const inputCount = isReroll ? headIndex - 1 : headIndex

        set((state) => {
          state.isInpainting = true
        })

        let targetFile = file
        if (originalImage && inputCount > 0) {
          const { canvas } = composeEntries(
            originalImage,
            originalImage.naturalWidth,
            originalImage.naturalHeight,
            entries,
            inputCount
          )
          targetFile = await canvasToFile(canvas, file.name, file.type)
        }

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [maskLineGroup],
          maskImages,
          BRUSH_COLOR
        )
        if (useLastLineGroup) {
          const temporaryMask = await canvasToImage(maskCanvas)
          set((state) => {
            state.editorState.temporaryMasks = castDraft([temporaryMask])
          })
        }

        try {
          const res = await inpaint(
            targetFile,
            settings,
            cropperState,
            extenderState,
            dataURItoBlob(maskCanvas.toDataURL()),
            paintByExampleFile
          )

          const { blob, seed } = res
          if (seed) {
            get().setSeed(parseInt(seed, 10))
          }
          const newRender = new Image()
          await loadImage(newRender, blob)
          get().setImageSize(newRender.width, newRender.height)

          if (settings.showExtender) {
            // Outpainting changes the canvas size -> structural rebase entry.
            const rebase: HistoryEntry = {
              kind: "rebase",
              id: genId(),
              enabled: true,
              canvas: cropToCanvas(newRender, {
                x: 0,
                y: 0,
                width: newRender.width,
                height: newRender.height,
              }),
              width: newRender.width,
              height: newRender.height,
              label: "Outpaint",
            }
            set((state) => {
              state.editorState.entries = castDraft([
                ...state.editorState.entries.slice(
                  0,
                  state.editorState.headIndex
                ),
                rebase,
              ])
              state.editorState.headIndex += 1
            })
          } else {
            const bbox =
              (settings.showCropper
                ? clampRect(cropperState, newRender.width, newRender.height)
                : bboxFromMaskCanvas(maskCanvas, settings.sdMaskBlur)) ?? {
                x: 0,
                y: 0,
                width: newRender.width,
                height: newRender.height,
              }
            const patch: HistoryEntry = {
              kind: "patch",
              id: genId(),
              enabled: true,
              bbox,
              canvas: cropToCanvas(newRender, bbox),
              lineGroup: maskLineGroup,
              extraMasks: maskImages,
              label: "Inpaint",
            }
            set((state) => {
              if (isReroll) {
                state.editorState.entries[state.editorState.headIndex - 1] =
                  castDraft(patch)
              } else {
                state.editorState.entries = castDraft([
                  ...state.editorState.entries.slice(
                    0,
                    state.editorState.headIndex
                  ),
                  patch,
                ])
                state.editorState.headIndex += 1
              }
            })
          }

          get().updateEditorState({
            lastLineGroup: maskLineGroup,
            curLineGroup: [],
            extraMasks: [],
            prevExtraMasks: maskImages,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }

        get().resetRedoState()
        set((state) => {
          state.isInpainting = false
          state.editorState.temporaryMasks = []
        })
      },

      runAutoTile: async () => {
        const {
          file,
          paintByExampleFile,
          imageWidth,
          imageHeight,
          settings,
          extenderState,
        } = get()
        if (file === null) {
          return
        }
        const { curLineGroup, extraMasks } = get().editorState
        const originalImage = await get().ensureOriginalImage()

        // Full mask covering the area the user wants filled.
        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [curLineGroup],
          extraMasks,
          BRUSH_COLOR
        )
        // computeTiles applies the context padding; keep this bbox tight.
        const maskBbox = bboxFromMaskCanvas(maskCanvas, 0)
        if (!maskBbox) {
          toast({
            variant: "destructive",
            description: "Please draw mask on picture",
          })
          return
        }

        const pad = settings.patchContextPad

        // Inset a tile's mask on edges that face other tiles (not the image
        // border), so each tile keeps an unmasked `pad`-wide context ring. This
        // is what gives a diffusion model something to condition on — a fully
        // masked tile would otherwise come back black. The ring's masked pixels
        // are covered by the neighbouring tile where they are interior.
        const innerMaskRect = (tile: Rect): Rect => {
          const left = tile.x <= 0 ? 0 : pad
          const top = tile.y <= 0 ? 0 : pad
          const right = tile.x + tile.width >= imageWidth ? 0 : pad
          const bottom = tile.y + tile.height >= imageHeight ? 0 : pad
          return {
            x: tile.x + left,
            y: tile.y + top,
            width: Math.max(0, tile.width - left - right),
            height: Math.max(0, tile.height - top - bottom),
          }
        }

        const tiles = computeTiles(maskBbox, {
          tileSize: settings.patchSize,
          overlap: settings.patchOverlap,
          contextPad: pad,
          imageW: imageWidth,
          imageH: imageHeight,
        }).filter((tile) => maskIntersectsRect(maskCanvas, innerMaskRect(tile)))

        if (tiles.length === 0) {
          toast({
            variant: "destructive",
            description: "Please draw mask on picture",
          })
          return
        }

        const batchId = genId()
        const total = tiles.length

        // Drop any redoable tail before appending the batch.
        set((state) => {
          state.isInpainting = true
          state.patchProgress = { total, done: 0 }
          state.editorState.entries = castDraft(
            state.editorState.entries.slice(0, state.editorState.headIndex)
          )
        })

        try {
          for (let i = 0; i < tiles.length; i += 1) {
            const tile = tiles[i]

            // Compose the current timeline (includes earlier tiles) as input,
            // so each tile's context ring uses already-improved pixels.
            let targetFile = file
            const { entries: curEntries, headIndex: curHead } =
              get().editorState
            if (originalImage && curHead > 0) {
              const { canvas } = composeEntries(
                originalImage,
                originalImage.naturalWidth,
                originalImage.naturalHeight,
                curEntries,
                curHead
              )
              targetFile = await canvasToFile(canvas, file.name, file.type)
            }

            const tileMask = clipMaskToRect(maskCanvas, innerMaskRect(tile))
            const res = await inpaint(
              targetFile,
              settings,
              tile,
              extenderState,
              dataURItoBlob(tileMask.toDataURL()),
              paintByExampleFile,
              true
            )
            const { blob, seed } = res
            if (seed) {
              get().setSeed(parseInt(seed, 10))
            }
            const newRender = new Image()
            await loadImage(newRender, blob)

            const bbox = clampRect(tile, newRender.width, newRender.height)
            // Feather inner edges so overlapping tiles cross-fade instead of
            // showing a hard rectangular seam.
            const patchCanvas = featherPatch(cropToCanvas(newRender, bbox), pad, {
              left: bbox.x > 0,
              top: bbox.y > 0,
              right: bbox.x + bbox.width < imageWidth,
              bottom: bbox.y + bbox.height < imageHeight,
            })
            const patch: HistoryEntry = {
              kind: "patch",
              id: genId(),
              enabled: true,
              bbox,
              canvas: patchCanvas,
              lineGroup: curLineGroup,
              extraMasks,
              batchId,
              label: `Patch ${i + 1}/${total}`,
            }
            set((state) => {
              state.editorState.entries.push(castDraft(patch))
              state.editorState.headIndex += 1
              if (state.patchProgress) {
                state.patchProgress.done = i + 1
              }
            })
          }

          get().updateEditorState({
            lastLineGroup: curLineGroup,
            curLineGroup: [],
            extraMasks: [],
            prevExtraMasks: extraMasks,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }

        get().resetRedoState()
        set((state) => {
          state.isInpainting = false
          state.patchProgress = null
        })
      },

      runRenderablePlugin: async (
        genMask: boolean,
        pluginName: string,
        params: PluginParams = { upscale: 1 }
      ) => {
        set((state) => {
          state.isPluginRunning = true
        })

        try {
          const start = new Date()
          const targetFile = await get().getCurrentTargetFile()
          const res = await runPlugin(
            genMask,
            pluginName,
            targetFile,
            params.upscale
          )
          const { blob } = res

          if (!genMask) {
            const newRender = new Image()
            await loadImage(newRender, blob)
            get().setImageSize(newRender.width, newRender.height)
            // Plugins (upscale / restore) may resize -> structural rebase entry.
            const rebase: HistoryEntry = {
              kind: "rebase",
              id: genId(),
              enabled: true,
              canvas: cropToCanvas(newRender, {
                x: 0,
                y: 0,
                width: newRender.width,
                height: newRender.height,
              }),
              width: newRender.width,
              height: newRender.height,
              label: pluginName,
            }
            set((state) => {
              state.editorState.entries = castDraft([
                ...state.editorState.entries.slice(
                  0,
                  state.editorState.headIndex
                ),
                rebase,
              ])
              state.editorState.headIndex += 1
            })
          } else {
            const newMask = new Image()
            await loadImage(newMask, blob)
            set((state) => {
              state.editorState.extraMasks.push(castDraft(newMask))
            })
          }
          const end = new Date()
          const time = end.getTime() - start.getTime()
          toast({
            description: `Run ${pluginName} successfully in ${time / 1000}s`,
          })
        } catch (e: any) {
          toast({
            variant: "destructive",
            description: e.message ? e.message : e.toString(),
          })
        }
        set((state) => {
          state.isPluginRunning = false
        })
      },

      // Edirot State //
      updateEditorState: (newState: Partial<EditorState>) => {
        set((state) => {
          state.editorState = castDraft({ ...state.editorState, ...newState })
        })
      },

      cleanCurLineGroup: () => {
        get().updateEditorState({ curLineGroup: [] })
      },

      handleCanvasMouseDown: (point: Point) => {
        let lineGroup: LineGroup = []
        const state = get()
        if (state.runMannually()) {
          lineGroup = [...state.editorState.curLineGroup]
        }
        lineGroup.push({ size: state.getBrushSize(), pts: [point] })
        set((state) => {
          state.editorState.curLineGroup = lineGroup
        })
      },

      handleCanvasMouseMove: (point: Point) => {
        set((state) => {
          const curLineGroup = state.editorState.curLineGroup
          if (curLineGroup.length) {
            curLineGroup[curLineGroup.length - 1].pts.push(point)
          }
        })
      },

      runMannually: (): boolean => {
        const state = get()
        return (
          state.settings.enableManualInpainting ||
          state.settings.model.model_type !== MODEL_TYPE_INPAINT
        )
      },

      getIsProcessing: (): boolean => {
        return (
          get().isInpainting || get().isPluginRunning || get().isAdjustingMask
        )
      },

      isSD: (): boolean => {
        return get().settings.model.model_type !== MODEL_TYPE_INPAINT
      },

      // undo/redo

      undoDisabled: (): boolean => {
        const editorState = get().editorState
        if (
          get().runMannually() &&
          editorState.curLineGroup.length !== 0
        ) {
          return false
        }
        return editorState.headIndex === 0
      },

      undo: () => {
        if (
          get().runMannually() &&
          get().editorState.curLineGroup.length !== 0
        ) {
          // undoStroke
          set((state) => {
            const editorState = state.editorState
            if (editorState.curLineGroup.length === 0) {
              return
            }
            editorState.lastLineGroup = []
            const lastLine = editorState.curLineGroup.pop()!
            editorState.redoCurLines.push(lastLine)
          })
        } else {
          set((state) => {
            const editorState = state.editorState
            const { entries, headIndex } = editorState
            if (headIndex === 0) {
              return
            }
            editorState.redoCurLines = []
            editorState.curLineGroup = []
            // Step over a whole patch-fill batch as a single undo unit.
            let target = headIndex - 1
            const last = entries[target]
            if (last.kind === "patch" && last.batchId) {
              const bId = last.batchId
              while (target > 0) {
                const prev = entries[target - 1]
                if (prev.kind === "patch" && prev.batchId === bId) {
                  target -= 1
                } else {
                  break
                }
              }
            }
            editorState.headIndex = target
          })
        }
      },

      redoDisabled: (): boolean => {
        const editorState = get().editorState
        if (get().runMannually() && editorState.redoCurLines.length !== 0) {
          return false
        }
        return editorState.headIndex >= editorState.entries.length
      },

      redo: () => {
        if (
          get().runMannually() &&
          get().editorState.redoCurLines.length !== 0
        ) {
          set((state) => {
            const editorState = state.editorState
            if (editorState.redoCurLines.length === 0) {
              return
            }
            const line = editorState.redoCurLines.pop()!
            editorState.curLineGroup.push(line)
          })
        } else {
          set((state) => {
            const editorState = state.editorState
            const { entries, headIndex } = editorState
            if (headIndex >= entries.length) {
              return
            }
            editorState.curLineGroup = []
            // Redo a whole patch-fill batch as a single unit.
            let target = headIndex + 1
            const first = entries[headIndex]
            if (first.kind === "patch" && first.batchId) {
              const bId = first.batchId
              while (target < entries.length) {
                const nxt = entries[target]
                if (nxt.kind === "patch" && nxt.batchId === bId) {
                  target += 1
                } else {
                  break
                }
              }
            }
            editorState.headIndex = target
          })
        }
      },

      resetRedoState: () => {
        set((state) => {
          state.editorState.redoCurLines = []
        })
      },

      //****//

      updateAppState: (newState: Partial<AppState>) => {
        set(() => newState)
      },

      getBrushSize: (): number => {
        return (
          get().editorState.baseBrushSize * get().editorState.brushSizeScale
        )
      },

      showPromptInput: (): boolean => {
        const model = get().settings.model
        return (
          model.model_type !== MODEL_TYPE_INPAINT &&
          model.name !== PAINT_BY_EXAMPLE
        )
      },

      setServerConfig: (newValue: ServerConfig) => {
        set((state) => {
          state.serverConfig = newValue
          state.settings.enableControlnet = newValue.enableControlnet
          state.settings.controlnetMethod = newValue.controlnetMethod
        })
      },

      updateSettings: (newSettings: Partial<Settings>) => {
        set((state) => {
          state.settings = {
            ...state.settings,
            ...newSettings,
          }
        })
      },

      updateEnablePowerPaintV2: (newValue: boolean) => {
        get().updateSettings({ enablePowerPaintV2: newValue })
        if (newValue) {
          get().updateSettings({
            enableBrushNet: false,
            enableControlnet: false,
            enableLCMLora: false,
          })
        }
      },

      updateEnableBrushNet: (newValue: boolean) => {
        get().updateSettings({ enableBrushNet: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableControlnet: false,
            enableLCMLora: false,
          })
        }
      },

      updateEnableControlnet(newValue) {
        get().updateSettings({ enableControlnet: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableBrushNet: false,
          })
        }
      },

      updateLCMLora(newValue) {
        get().updateSettings({ enableLCMLora: newValue })
        if (newValue) {
          get().updateSettings({
            enablePowerPaintV2: false,
            enableBrushNet: false,
          })
        }
      },

      setModel: (newModel: ModelInfo) => {
        set((state) => {
          state.settings.model = newModel

          if (
            newModel.support_controlnet &&
            !newModel.controlnets.includes(state.settings.controlnetMethod)
          ) {
            state.settings.controlnetMethod = newModel.controlnets[0]
          }
        })
      },

      updateFileManagerState: (newState: Partial<FileManagerState>) => {
        set((state) => {
          state.fileManagerState = {
            ...state.fileManagerState,
            ...newState,
          }
        })
      },

      updateInteractiveSegState: (newState: Partial<InteractiveSegState>) => {
        set((state) => {
          return {
            ...state,
            interactiveSegState: {
              ...state.interactiveSegState,
              ...newState,
            },
          }
        })
      },

      resetInteractiveSegState: () => {
        get().updateInteractiveSegState(defaultValues.interactiveSegState)
      },

      handleInteractiveSegAccept: () => {
        set((state) => {
          if (state.interactiveSegState.tmpInteractiveSegMask) {
            state.editorState.extraMasks.push(
              castDraft(state.interactiveSegState.tmpInteractiveSegMask)
            )
          }
          state.interactiveSegState = castDraft({
            ...defaultValues.interactiveSegState,
          })
        })
      },

      handleFileManagerMaskSelect: async (blob: Blob) => {
        const newMask = new Image()

        await loadImage(newMask, URL.createObjectURL(blob))
        set((state) => {
          state.editorState.extraMasks.push(castDraft(newMask))
        })
        get().runInpainting()
      },

      setIsInpainting: (newValue: boolean) =>
        set((state) => {
          state.isInpainting = newValue
        }),

      setFile: async (file: File) => {
        if (get().settings.enableAutoExtractPrompt) {
          try {
            const res = await getGenInfo(file)
            if (res.prompt) {
              set((state) => {
                state.settings.prompt = res.prompt
              })
            }
            if (res.negative_prompt) {
              set((state) => {
                state.settings.negativePrompt = res.negative_prompt
              })
            }
          } catch (e: any) {
            toast({
              variant: "destructive",
              description: e.message ? e.message : e.toString(),
            })
          }
        }
        let originalImage: HTMLImageElement | null = null
        try {
          originalImage = await fileToImage(file)
        } catch (e) {
          console.error(e)
        }
        set((state) => {
          state.file = file
          state.interactiveSegState = castDraft(
            defaultValues.interactiveSegState
          )
          state.editorState = castDraft({
            ...defaultValues.editorState,
            originalImage,
          })
          state.cropperState = defaultValues.cropperState
        })
      },

      setCustomFile: (file: File) =>
        set((state) => {
          state.customMask = file
        }),

      setBaseBrushSize: (newValue: number) =>
        set((state) => {
          state.editorState.baseBrushSize = newValue
        }),

      decreaseBaseBrushSize: () => {
        const baseBrushSize = get().editorState.baseBrushSize
        let newBrushSize = baseBrushSize
        if (baseBrushSize > 10) {
          newBrushSize = baseBrushSize - 10
        }
        if (baseBrushSize <= 10 && baseBrushSize > 0) {
          newBrushSize = baseBrushSize - 3
        }
        get().setBaseBrushSize(newBrushSize)
      },

      increaseBaseBrushSize: () => {
        const baseBrushSize = get().editorState.baseBrushSize
        const newBrushSize = Math.min(baseBrushSize + 10, MAX_BRUSH_SIZE)
        get().setBaseBrushSize(newBrushSize)
      },

      setImageSize: (width: number, height: number) => {
        // 根据图片尺寸调整 brushSize 的 scale
        set((state) => {
          state.imageWidth = width
          state.imageHeight = height
          state.editorState.brushSizeScale =
            Math.max(Math.min(width, height), 512) / 512
        })
        get().resetExtender(width, height)
      },

      setCropperX: (newValue: number) =>
        set((state) => {
          state.cropperState.x = newValue
        }),

      setCropperY: (newValue: number) =>
        set((state) => {
          state.cropperState.y = newValue
        }),

      setCropperWidth: (newValue: number) =>
        set((state) => {
          state.cropperState.width = newValue
        }),

      setCropperHeight: (newValue: number) =>
        set((state) => {
          state.cropperState.height = newValue
        }),

      // Set the cropper to a fixed square size.
      setCropperSize: (size: number) => get().setCropperDimensions(size, size),

      // Set the cropper width/height, clamped to the image and kept inside its
      // bounds (keeps the current top-left, nudging it in if needed).
      setCropperDimensions: (width: number, height: number) =>
        set((state) => {
          const { imageWidth, imageHeight } = state
          const w = Math.min(width, imageWidth)
          const h = Math.min(height, imageHeight)
          state.cropperState.width = w
          state.cropperState.height = h
          state.cropperState.x = Math.max(
            0,
            Math.min(state.cropperState.x, imageWidth - w)
          )
          state.cropperState.y = Math.max(
            0,
            Math.min(state.cropperState.y, imageHeight - h)
          )
        }),

      // Presets are persisted server-side (so they live in the darktable config
      // dir and get backed up with it), not in browser localStorage.
      setPresets: (presets: Preset[]) =>
        set((state) => {
          state.presets = presets
        }),

      loadPresets: async () => {
        const presets = await getPresets()
        set((state) => {
          state.presets = presets
        })
      },

      // Snapshot the current settings (model included) under `name`, replacing
      // any existing preset with the same name. Kept sorted by name, then
      // persisted to the server.
      savePreset: async (name: string) => {
        const snapshot = JSON.parse(
          JSON.stringify(get().settings)
        ) as Settings
        const { width, height } = get().cropperState
        const others = get().presets.filter((p) => p.name !== name)
        const presets = [
          ...others,
          { name, settings: snapshot, cropper: { width, height } },
        ].sort((a, b) => a.name.localeCompare(b.name))
        set((state) => {
          state.presets = presets
        })
        await savePresets(presets)
      },

      deletePreset: async (name: string) => {
        const presets = get().presets.filter((p) => p.name !== name)
        set((state) => {
          state.presets = presets
        })
        await savePresets(presets)
      },

      setExtenderX: (newValue: number) =>
        set((state) => {
          state.extenderState.x = newValue
        }),

      setExtenderY: (newValue: number) =>
        set((state) => {
          state.extenderState.y = newValue
        }),

      setExtenderWidth: (newValue: number) =>
        set((state) => {
          state.extenderState.width = newValue
        }),

      setExtenderHeight: (newValue: number) =>
        set((state) => {
          state.extenderState.height = newValue
        }),

      setIsCropperExtenderResizing: (newValue: boolean) =>
        set((state) => {
          state.isCropperExtenderResizing = newValue
        }),

      updateExtenderDirection: (newValue: ExtenderDirection) => {
        console.log(
          `updateExtenderDirection: ${JSON.stringify(get().extenderState)}`
        )
        set((state) => {
          state.settings.extenderDirection = newValue
          state.extenderState.x = 0
          state.extenderState.y = 0
          state.extenderState.width = state.imageWidth
          state.extenderState.height = state.imageHeight
        })
        get().updateExtenderByBuiltIn(newValue, 1.5)
      },

      updateExtenderByBuiltIn: (
        direction: ExtenderDirection,
        scale: number
      ) => {
        const newExtenderState = { ...defaultValues.extenderState }
        let { x, y, width, height } = newExtenderState
        const { imageWidth, imageHeight } = get()
        width = imageWidth
        height = imageHeight

        switch (direction) {
          case ExtenderDirection.x:
            x = -Math.ceil((imageWidth * (scale - 1)) / 2)
            width = Math.ceil(imageWidth * scale)
            break
          case ExtenderDirection.y:
            y = -Math.ceil((imageHeight * (scale - 1)) / 2)
            height = Math.ceil(imageHeight * scale)
            break
          case ExtenderDirection.xy:
            x = -Math.ceil((imageWidth * (scale - 1)) / 2)
            y = -Math.ceil((imageHeight * (scale - 1)) / 2)
            width = Math.ceil(imageWidth * scale)
            height = Math.ceil(imageHeight * scale)
            break
          default:
            break
        }

        set((state) => {
          state.extenderState.x = x
          state.extenderState.y = y
          state.extenderState.width = width
          state.extenderState.height = height
        })
      },

      resetExtender: (width: number, height: number) => {
        set((state) => {
          state.extenderState.x = 0
          state.extenderState.y = 0
          state.extenderState.width = width
          state.extenderState.height = height
        })
      },

      setSeed: (newValue: number) =>
        set((state) => {
          state.settings.seed = newValue
        }),

      adjustMask: async (operate: AdjustMaskOperate) => {
        const { imageWidth, imageHeight } = get()
        const { curLineGroup, extraMasks } = get().editorState
        const { adjustMaskKernelSize } = get().settings
        if (curLineGroup.length === 0 && extraMasks.length === 0) {
          return
        }

        set((state) => {
          state.isAdjustingMask = true
        })

        const maskCanvas = generateMask(
          imageWidth,
          imageHeight,
          [curLineGroup],
          extraMasks,
          BRUSH_COLOR
        )
        const maskBlob = dataURItoBlob(maskCanvas.toDataURL())
        const newMaskBlob = await postAdjustMask(
          maskBlob,
          operate,
          adjustMaskKernelSize
        )
        const newMask = await blobToImage(newMaskBlob)

        // TODO: currently ignore stroke undo/redo
        set((state) => {
          state.editorState.extraMasks = [castDraft(newMask)]
          state.editorState.curLineGroup = []
        })

        set((state) => {
          state.isAdjustingMask = false
        })
      },
      clearMask: () => {
        set((state) => {
          state.editorState.extraMasks = []
          state.editorState.curLineGroup = []
        })
      },
    })),
    {
      name: "ZUSTAND_STATE", // name of the item in the storage (must be unique)
      version: 2,
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(([key]) =>
            ["fileManagerState", "settings"].includes(key)
          )
        ),
      // Deep-merge persisted `settings`/`fileManagerState` over the defaults so
      // newly added fields (e.g. patch-fill options) fall back to their default
      // instead of becoming `undefined` for users with older localStorage.
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<
          AppState & AppAction
        >
        return {
          ...currentState,
          ...persisted,
          settings: {
            ...currentState.settings,
            ...(persisted.settings ?? {}),
          },
          fileManagerState: {
            ...currentState.fileManagerState,
            ...(persisted.fileManagerState ?? {}),
          },
        }
      },
    }
  ),
  shallow
)
