import { ReactNode, useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  History,
  Lock,
  RotateCw,
  SlidersHorizontal,
  Stamp,
  Trash2,
  X,
} from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Settings, useStore } from "@/lib/states"
import { cn } from "@/lib/utils"
import { MODEL_TYPE_INPAINT } from "@/lib/const"
import { HistoryEntry, PatchEntry } from "@/lib/types"

function Thumb({ canvas }: { canvas: HTMLCanvasElement }) {
  const src = useMemo(() => canvas.toDataURL(), [canvas])
  return (
    <img
      src={src}
      alt=""
      className="h-12 w-12 shrink-0 rounded border bg-muted object-cover"
    />
  )
}

// Human-readable summary of the settings a patch was produced with. Only the
// params that actually applied to the model are shown.
function settingsRows(settings: Settings): [string, string][] {
  const rows: [string, string][] = [["Model", settings.model.name]]
  const isDiffusion = settings.model.model_type !== MODEL_TYPE_INPAINT
  if (isDiffusion) {
    if (settings.prompt) {
      rows.push(["Prompt", settings.prompt])
    }
    if (settings.negativePrompt) {
      rows.push(["Negative", settings.negativePrompt])
    }
    rows.push(["Steps", String(settings.sdSteps)])
    rows.push(["Guidance", String(settings.sdGuidanceScale)])
    if (settings.model.support_strength) {
      rows.push(["Strength", String(settings.sdStrength)])
    }
    rows.push(["Sampler", settings.sdSampler])
    rows.push(["Mask blur", String(settings.sdMaskBlur)])
  }
  rows.push(["Seed", settings.seedFixed ? String(settings.seed) : "random"])
  if (settings.patchFill) {
    rows.push([
      "Patch fill",
      `${settings.patchSize}px · ${settings.patchOverlap} ov · ${settings.patchContextPad} ctx`,
    ])
  }
  return rows
}

function SettingsDetails({ settings }: { settings: Settings }) {
  return (
    <div className="mt-2 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
      {settingsRows(settings).map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 flex-1 break-words">{value}</span>
        </div>
      ))}
    </div>
  )
}

function ActionButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

// Permanently removes an edit from the history. Destructive and not undoable
// (the timeline undo can't bring a deleted entry back), so it confirms first.
function DeleteButton({
  disabled,
  description,
  onConfirm,
}: {
  disabled: boolean
  description: string
  onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          title="Delete edit"
          aria-label="Delete edit"
          disabled={disabled}
        >
          <Trash2 size={15} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this edit?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Always-visible row of per-edit actions, so reapplying/retrying/deleting an
// edit never requires expanding the card. "Reuse mask" reloads the mask (no
// run); "Load settings" applies the saved settings (switching model if needed,
// no run); "Retry" re-runs this patch in place for a fresh result; "Delete"
// removes it. `onRetry` is omitted for patch-fill batches (retry is per-patch).
function ActionBar({
  disabled,
  onReuse,
  onLoad,
  onRetry,
  deleteDescription,
  onDelete,
}: {
  disabled: boolean
  onReuse: () => void
  onLoad: () => void
  onRetry?: () => void
  deleteDescription: string
  onDelete: () => void
}) {
  return (
    <div className="mt-2 flex items-center justify-end gap-1">
      <ActionButton title="Reuse mask" disabled={disabled} onClick={onReuse}>
        <Stamp size={15} />
      </ActionButton>
      <ActionButton title="Load settings" disabled={disabled} onClick={onLoad}>
        <SlidersHorizontal size={15} />
      </ActionButton>
      {onRetry ? (
        <ActionButton title="Retry" disabled={disabled} onClick={onRetry}>
          <RotateCw size={15} />
        </ActionButton>
      ) : null}
      <DeleteButton
        disabled={disabled}
        description={deleteDescription}
        onConfirm={onDelete}
      />
    </div>
  )
}

type Group =
  | { type: "single"; entry: HistoryEntry }
  | { type: "batch"; batchId: string; entries: PatchEntry[] }

const HistoryPanel = () => {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [
    entries,
    headIndex,
    isProcessing,
    togglePatch,
    setBatchEnabled,
    deletePatch,
    deleteBatch,
    retryPatch,
    reuseMask,
    applySettings,
  ] = useStore((state) => [
    state.editorState.entries,
    state.editorState.headIndex,
    state.getIsProcessing(),
    state.togglePatch,
    state.setBatchEnabled,
    state.deletePatch,
    state.deleteBatch,
    state.retryPatch,
    state.reuseMask,
    state.applySettings,
  ])

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Active timeline entries, grouped so that the tiles of one auto-tile run
  // collapse into a single batch with a master toggle.
  const groups = useMemo<Group[]>(() => {
    const out: Group[] = []
    entries.slice(0, headIndex).forEach((entry) => {
      if (entry.kind === "patch" && entry.batchId) {
        const last = out[out.length - 1]
        if (last && last.type === "batch" && last.batchId === entry.batchId) {
          last.entries.push(entry)
          return
        }
        out.push({ type: "batch", batchId: entry.batchId, entries: [entry] })
      } else {
        out.push({ type: "single", entry })
      }
    })
    return out
  }, [entries, headIndex])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        className={cn("h-8 gap-1", open && "border-primary text-primary")}
      >
        <History size={16} />
        Edit history
      </Button>

      <Sheet open={open} modal={false}>
        <SheetContent
          side="left"
          className="w-[320px] max-w-full mt-[108px] p-4 outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle className="flex items-center justify-between">
              Edit history
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </Button>
            </SheetTitle>
          </SheetHeader>

          {groups.length === 0 ? (
            <div className="mt-3 text-sm text-muted-foreground">
              No edits yet. Draw a mask and run to add edits here.
            </div>
          ) : (
            <ScrollArea className="mt-3 h-[calc(100vh-208px)] pr-3 [&_[data-radix-scroll-area-viewport]>div]:!block">
              <div className="flex flex-col gap-2">
                {/* newest first */}
                {groups
                  .slice()
                  .reverse()
                  .map((group) => {
                    if (group.type === "single") {
                      const { entry } = group
                      const isPatch = entry.kind === "patch"
                      const isExpanded = expanded.has(entry.id)
                      return (
                        <div
                          key={entry.id}
                          className="rounded-md border p-2"
                        >
                          <div className="flex items-center gap-3">
                            <Thumb canvas={entry.canvas} />
                            <div className="min-w-0 flex-1 truncate text-sm">
                              {entry.label}
                            </div>
                            {isPatch ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  aria-label="Toggle details"
                                  className="text-muted-foreground hover:text-foreground"
                                  onClick={() => toggleExpanded(entry.id)}
                                >
                                  {isExpanded ? (
                                    <ChevronDown size={16} />
                                  ) : (
                                    <ChevronRight size={16} />
                                  )}
                                </button>
                                <Switch
                                  checked={entry.enabled}
                                  onCheckedChange={() => togglePatch(entry.id)}
                                />
                              </div>
                            ) : (
                              <Lock
                                size={16}
                                className="text-muted-foreground"
                              />
                            )}
                          </div>
                          {isPatch ? (
                            <ActionBar
                              disabled={isProcessing}
                              onReuse={() => reuseMask(entry.id)}
                              onLoad={() =>
                                applySettings(
                                  entry.settings,
                                  entry.cropper,
                                  entry.label
                                )
                              }
                              onRetry={() => retryPatch(entry.id)}
                              deleteDescription={`"${entry.label}" will be removed from the history. This can't be undone.`}
                              onDelete={() => deletePatch(entry.id)}
                            />
                          ) : null}
                          {isPatch && isExpanded ? (
                            <SettingsDetails settings={entry.settings} />
                          ) : null}
                        </div>
                      )
                    }

                    const allEnabled = group.entries.every((e) => e.enabled)
                    const first = group.entries[0]
                    const isExpanded = expanded.has(group.batchId)
                    return (
                      <div
                        key={group.batchId}
                        className="rounded-md border p-2"
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1 truncate text-sm font-medium">
                            Patch fill — {group.entries.length} tiles
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              aria-label="Toggle details"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => toggleExpanded(group.batchId)}
                            >
                              {isExpanded ? (
                                <ChevronDown size={16} />
                              ) : (
                                <ChevronRight size={16} />
                              )}
                            </button>
                            <Switch
                              checked={allEnabled}
                              onCheckedChange={(v) =>
                                setBatchEnabled(group.batchId, v)
                              }
                            />
                          </div>
                        </div>
                        <ActionBar
                          disabled={isProcessing}
                          onReuse={() => reuseMask(first.id)}
                          onLoad={() =>
                            applySettings(
                              first.settings,
                              first.cropper,
                              "Patch fill"
                            )
                          }
                          deleteDescription={`This patch-fill run (${group.entries.length} tiles) will be removed from the history. This can't be undone.`}
                          onDelete={() => deleteBatch(group.batchId)}
                        />
                        {isExpanded ? (
                          <SettingsDetails settings={first.settings} />
                        ) : null}
                        <div className="mt-2 flex flex-col gap-2">
                          {group.entries
                            .slice()
                            .reverse()
                            .map((entry) => (
                              <div
                                key={entry.id}
                                className="flex items-center gap-3 pl-2"
                              >
                                <Thumb canvas={entry.canvas} />
                                <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                  {entry.label}
                                </div>
                                <Switch
                                  checked={entry.enabled}
                                  onCheckedChange={() => togglePatch(entry.id)}
                                />
                              </div>
                            ))}
                        </div>
                      </div>
                    )
                  })}
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

export default HistoryPanel
