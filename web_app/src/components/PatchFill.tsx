import { useState } from "react"
import { LayoutGrid, SlidersHorizontal } from "lucide-react"

import { useStore } from "@/lib/states"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { Button, IconButton } from "./ui/button"
import { NumberInput } from "./ui/input"
import { Label } from "./ui/label"
import { cn } from "@/lib/utils"
import {
  DEFAULT_PATCH_DEFAULTS,
  PATCH_DEFAULTS_BY_MODEL_TYPE,
} from "@/lib/const"

const Row = ({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) => (
  <div className="flex justify-between items-center gap-3">
    <Label className="font-medium">{label}</Label>
    {children}
  </div>
)

type Draft = {
  patchSize: number
  patchOverlap: number
  patchContextPad: number
}

const PatchFill = () => {
  const [settings, patchProgress, isProcessing, updateSettings] = useStore(
    (state) => [
      state.settings,
      state.patchProgress,
      state.getIsProcessing(),
      state.updateSettings,
    ]
  )
  const [open, setOpen] = useState(false)
  // Edited locally so typing never writes to the store (which would re-run the
  // tile preview and snap clamped values back mid-keystroke).
  const [draft, setDraft] = useState<Draft>({
    patchSize: settings.patchSize,
    patchOverlap: settings.patchOverlap,
    patchContextPad: settings.patchContextPad,
  })

  const togglePatchFill = () => {
    const next = !settings.patchFill
    updateSettings({ patchFill: next })
    if (next) {
      updateSettings({ showCropper: false, showExtender: false })
    }
  }

  const openSettings = () => {
    setDraft({
      patchSize: settings.patchSize,
      patchOverlap: settings.patchOverlap,
      patchContextPad: settings.patchContextPad,
    })
    setOpen(true)
  }

  const commit = () => {
    updateSettings({
      patchSize: Math.max(64, Math.round(draft.patchSize || 0)),
      patchOverlap: Math.max(0, Math.round(draft.patchOverlap || 0)),
      patchContextPad: Math.max(0, Math.round(draft.patchContextPad || 0)),
    })
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      commit()
    }
    setOpen(next)
  }

  const resetDefaults = () => {
    const d =
      PATCH_DEFAULTS_BY_MODEL_TYPE[settings.model.model_type] ??
      DEFAULT_PATCH_DEFAULTS
    setDraft({ ...d })
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={isProcessing}
        onClick={togglePatchFill}
        className={cn(
          "h-8 gap-1",
          settings.patchFill && "border-primary text-primary"
        )}
      >
        <LayoutGrid size={16} />
        Patch fill
      </Button>

      <IconButton tooltip="Patch fill settings" onClick={openSettings}>
        <SlidersHorizontal size={16} />
      </IconButton>

      {patchProgress ? (
        <div className="text-xs rounded-md border px-2 py-1 bg-background">
          Patch fill {patchProgress.done}/{patchProgress.total}
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-[320px]">
          <DialogHeader>
            <DialogTitle>Patch fill settings</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Row label="Patch size">
              <NumberInput
                className="w-[90px]"
                numberValue={draft.patchSize}
                allowFloat={false}
                onNumberValueChange={(val) =>
                  setDraft((d) => ({ ...d, patchSize: val }))
                }
              />
            </Row>
            <Row label="Overlap">
              <NumberInput
                className="w-[90px]"
                numberValue={draft.patchOverlap}
                allowFloat={false}
                onNumberValueChange={(val) =>
                  setDraft((d) => ({ ...d, patchOverlap: val }))
                }
              />
            </Row>
            <Row label="Context">
              <NumberInput
                className="w-[90px]"
                numberValue={draft.patchContextPad}
                allowFloat={false}
                onNumberValueChange={(val) =>
                  setDraft((d) => ({ ...d, patchContextPad: val }))
                }
              />
            </Row>
            <p className="text-xs text-muted-foreground">
              Overlap should stay above 2 × Context so neighbouring tiles blend.
              Changes apply when you close this dialog.
            </p>
            <Button variant="outline" size="sm" onClick={resetDefaults}>
              Reset model defaults
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default PatchFill
