import { useState } from "react"

import { useStore } from "@/lib/states"
import { ExtenderDirection } from "@/lib/types"
import {
  DEFAULT_PATCH_DEFAULTS,
  PATCH_DEFAULTS_BY_MODEL_TYPE,
} from "@/lib/const"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs"
import { Button } from "../ui/button"
import { NumberInput } from "../ui/input"
import { Label } from "../ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select"
import { RowContainer } from "./LabelTitle"

type Workflow = "whole" | "cropper" | "extender" | "patch"

type PatchDraft = {
  patchSize: number
  patchOverlap: number
  patchContextPad: number
}

const PatchRow = ({
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

const WorkflowTabs = () => {
  const [
    settings,
    isProcessing,
    updateSettings,
    setCropperSize,
    updateExtenderByBuiltIn,
    updateExtenderDirection,
  ] = useStore((state) => [
    state.settings,
    state.getIsProcessing(),
    state.updateSettings,
    state.setCropperSize,
    state.updateExtenderByBuiltIn,
    state.updateExtenderDirection,
  ])

  const supportsExtender = settings.model.support_outpainting

  const active: Workflow = settings.patchFill
    ? "patch"
    : settings.showCropper
      ? "cropper"
      : settings.showExtender && supportsExtender
        ? "extender"
        : "whole"

  // Edited locally so typing never writes to the store (which would re-run the
  // tile preview and snap clamped values back mid-keystroke). Committed on blur.
  const [draft, setDraft] = useState<PatchDraft>({
    patchSize: settings.patchSize,
    patchOverlap: settings.patchOverlap,
    patchContextPad: settings.patchContextPad,
  })

  const commitPatch = () => {
    updateSettings({
      patchSize: Math.max(64, Math.round(draft.patchSize || 0)),
      patchOverlap: Math.max(0, Math.round(draft.patchOverlap || 0)),
      patchContextPad: Math.max(0, Math.round(draft.patchContextPad || 0)),
    })
  }

  const resetPatchDefaults = () => {
    const d =
      PATCH_DEFAULTS_BY_MODEL_TYPE[settings.model.model_type] ??
      DEFAULT_PATCH_DEFAULTS
    setDraft({ ...d })
    updateSettings({ ...d })
  }

  const onWorkflowChange = (value: string) => {
    switch (value as Workflow) {
      case "cropper":
        updateSettings({
          showCropper: true,
          showExtender: false,
          patchFill: false,
        })
        break
      case "extender":
        updateSettings({
          showExtender: true,
          showCropper: false,
          patchFill: false,
        })
        break
      case "patch":
        // Sync the draft from the store so the inputs reflect the current values
        // when the tab is (re)opened.
        setDraft({
          patchSize: settings.patchSize,
          patchOverlap: settings.patchOverlap,
          patchContextPad: settings.patchContextPad,
        })
        updateSettings({
          patchFill: true,
          showCropper: false,
          showExtender: false,
        })
        break
      default:
        // "whole": plain full-image processing. Respect the explicit choice and
        // do not auto-enable the cropper.
        updateSettings({
          showCropper: false,
          showExtender: false,
          patchFill: false,
        })
    }
  }

  return (
    <Tabs value={active} onValueChange={onWorkflowChange}>
      <TabsList className="w-full">
        <TabsTrigger
          className="flex-1 px-2 text-xs"
          value="whole"
          disabled={isProcessing}
        >
          Whole
        </TabsTrigger>
        <TabsTrigger
          className="flex-1 px-2 text-xs"
          value="cropper"
          disabled={isProcessing}
        >
          Cropper
        </TabsTrigger>
        {supportsExtender ? (
          <TabsTrigger
            className="flex-1 px-2 text-xs"
            value="extender"
            disabled={isProcessing}
          >
            Extender
          </TabsTrigger>
        ) : null}
        <TabsTrigger
          className="flex-1 px-2 text-xs"
          value="patch"
          disabled={isProcessing}
        >
          Patch fill
        </TabsTrigger>
      </TabsList>

      <TabsContent value="whole" className="pr-4">
        <p className="text-xs text-muted-foreground">
          Process the entire image at once.
        </p>
      </TabsContent>

      <TabsContent value="cropper" className="flex flex-col gap-2 pr-4">
        <p className="text-xs text-muted-foreground">
          Inpaint only a region of the image to improve speed and reduce memory
          use. Drag the box on the canvas, or pick a size:
        </p>
        <div className="flex gap-1">
          {[512, 768, 1024].map((size) => (
            <Button
              key={size}
              variant="outline"
              className="p-1 h-8 flex-1"
              onClick={() => setCropperSize(size)}
            >
              {size}
            </Button>
          ))}
        </div>
      </TabsContent>

      {supportsExtender ? (
        <TabsContent value="extender" className="flex flex-col gap-2 pr-4">
          <p className="text-xs text-muted-foreground">
            Outpaint to expand the image. Pick an axis and scale, or drag the
            box on the canvas:
          </p>
          <RowContainer>
            <Select
              value={settings.extenderDirection}
              onValueChange={(value) => {
                updateExtenderDirection(value as ExtenderDirection)
              }}
            >
              <SelectTrigger className="w-[65px] h-7">
                <SelectValue placeholder="Select axis" />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {Object.values(ExtenderDirection).map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <div className="flex gap-1 justify-center">
              {[1.25, 1.5, 1.75, 2.0].map((scale) => (
                <Button
                  key={scale}
                  variant="outline"
                  className="p-1 h-8"
                  onClick={() =>
                    updateExtenderByBuiltIn(settings.extenderDirection, scale)
                  }
                >
                  {scale}x
                </Button>
              ))}
            </div>
          </RowContainer>
        </TabsContent>
      ) : null}

      <TabsContent value="patch" className="flex flex-col gap-3 pr-4">
        {/* onBlur on the wrapper commits the draft when any input loses focus. */}
        <div className="flex flex-col gap-3" onBlur={commitPatch}>
          <PatchRow label="Patch size">
            <NumberInput
              className="w-[90px]"
              numberValue={draft.patchSize}
              allowFloat={false}
              onNumberValueChange={(val) =>
                setDraft((d) => ({ ...d, patchSize: val }))
              }
            />
          </PatchRow>
          <PatchRow label="Overlap">
            <NumberInput
              className="w-[90px]"
              numberValue={draft.patchOverlap}
              allowFloat={false}
              onNumberValueChange={(val) =>
                setDraft((d) => ({ ...d, patchOverlap: val }))
              }
            />
          </PatchRow>
          <PatchRow label="Context">
            <NumberInput
              className="w-[90px]"
              numberValue={draft.patchContextPad}
              allowFloat={false}
              onNumberValueChange={(val) =>
                setDraft((d) => ({ ...d, patchContextPad: val }))
              }
            />
          </PatchRow>
        </div>
        <p className="text-xs text-muted-foreground">
          Covers a large masked area with overlapping tiles. Overlap should stay
          above 2 × Context so neighbouring tiles blend.
        </p>
        <Button variant="outline" size="sm" onClick={resetPatchDefaults}>
          Reset model defaults
        </Button>
      </TabsContent>
    </Tabs>
  )
}

export default WorkflowTabs
