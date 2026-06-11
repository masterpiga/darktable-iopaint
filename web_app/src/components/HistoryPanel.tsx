import { useMemo, useState } from "react"
import { History, Lock, X } from "lucide-react"

import { Button, IconButton } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { useStore } from "@/lib/states"
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

type Group =
  | { type: "single"; entry: HistoryEntry }
  | { type: "batch"; batchId: string; entries: PatchEntry[] }

const HistoryPanel = () => {
  const [open, setOpen] = useState(false)
  const [entries, headIndex, togglePatch, setBatchEnabled] = useStore(
    (state) => [
      state.editorState.entries,
      state.editorState.headIndex,
      state.togglePatch,
      state.setBatchEnabled,
    ]
  )

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
      <IconButton tooltip="Edit history" onClick={() => setOpen(true)}>
        <History />
      </IconButton>

      <Sheet open={open} modal={false}>
        <SheetContent
          side="left"
          className="w-[320px] max-w-full mt-[60px] p-4 outline-none"
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
            <ScrollArea className="mt-3 h-[calc(100vh-160px)] pr-3">
              <div className="flex flex-col gap-2">
                {/* newest first */}
                {groups
                  .slice()
                  .reverse()
                  .map((group) => {
                    if (group.type === "single") {
                      const { entry } = group
                      const isPatch = entry.kind === "patch"
                      return (
                        <div
                          key={entry.id}
                          className="flex items-center gap-3 rounded-md border p-2"
                        >
                          <Thumb canvas={entry.canvas} />
                          <div className="flex-1 text-sm">{entry.label}</div>
                          {isPatch ? (
                            <Switch
                              checked={entry.enabled}
                              onCheckedChange={() => togglePatch(entry.id)}
                            />
                          ) : (
                            <Lock
                              size={16}
                              className="text-muted-foreground"
                            />
                          )}
                        </div>
                      )
                    }

                    const allEnabled = group.entries.every((e) => e.enabled)
                    return (
                      <div
                        key={group.batchId}
                        className="rounded-md border p-2"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-1 text-sm font-medium">
                            Patch fill — {group.entries.length} tiles
                          </div>
                          <Switch
                            checked={allEnabled}
                            onCheckedChange={(v) =>
                              setBatchEnabled(group.batchId, v)
                            }
                          />
                        </div>
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
                                <div className="flex-1 text-xs text-muted-foreground">
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
