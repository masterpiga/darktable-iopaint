import { useEffect, useMemo, useState } from "react"
import { Bookmark, BookmarkCheck, Check, Save, Trash2 } from "lucide-react"

import { useStore, Settings } from "@/lib/states"
import { switchModel } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button, IconButton } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

const PresetSelect = () => {
  const [
    presets,
    settings,
    cropperState,
    serverConfig,
    updateSettings,
    setModel,
    setCropperDimensions,
    updateAppState,
    loadPresets,
    savePreset,
    deletePreset,
  ] = useStore((state) => [
    state.presets,
    state.settings,
    state.cropperState,
    state.serverConfig,
    state.updateSettings,
    state.setModel,
    state.setCropperDimensions,
    state.updateAppState,
    state.loadPresets,
    state.savePreset,
    state.deletePreset,
  ])

  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState("")

  // The "active" preset is whichever one's snapshot matches the current settings.
  // Deriving it (rather than tracking state) means it lights up when a preset is
  // loaded and clears itself as soon as any setting is changed. The model is
  // compared by name, since the live ModelInfo can differ from the snapshot.
  const activePresetName = useMemo(() => {
    const norm = (s: Settings) => JSON.stringify({ ...s, model: s.model?.name })
    const current = norm(settings)
    return (
      presets.find((p) => {
        if (norm(p.settings) !== current) {
          return false
        }
        // Cropper size lives outside `settings`; only relevant when the cropper
        // is on (settings already matched, so showCropper is equal on both).
        if (settings.showCropper && p.cropper) {
          return (
            p.cropper.width === cropperState.width &&
            p.cropper.height === cropperState.height
          )
        }
        return true
      })?.name ?? null
    )
  }, [presets, settings, cropperState])

  // Load presets from the server (they live in the darktable config dir).
  useEffect(() => {
    loadPresets().catch((error: any) => {
      toast({
        variant: "destructive",
        title: `Failed to load presets: ${error}`,
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyPreset = async (presetName: string) => {
    const preset = presets.find((p) => p.name === presetName)
    if (!preset) {
      return
    }
    const target = preset.settings
    const needSwitch = target.model.name !== settings.model.name

    // Cropper size lives outside `settings`; restore it when the cropper is on.
    const applyCropper = () => {
      if (target.showCropper && preset.cropper) {
        setCropperDimensions(preset.cropper.width, preset.cropper.height)
      }
    }

    if (needSwitch && serverConfig.disableModelSwitch) {
      toast({
        variant: "destructive",
        title: `Preset "${preset.name}" needs model "${target.model.name}", but model switching is disabled on this server. Applied the other settings only.`,
      })
      updateSettings({ ...target, model: settings.model })
      applyCropper()
      return
    }

    try {
      if (needSwitch) {
        updateAppState({ disableShortCuts: true })
        const newModel = await switchModel(target.model.name)
        updateSettings(target)
        setModel(newModel)
        applyCropper()
        toast({
          title: `Loaded preset "${preset.name}" (switched to ${newModel.name})`,
        })
      } else {
        // keep the live model object, just apply the rest of the settings
        updateSettings({ ...target, model: settings.model })
        applyCropper()
        toast({ title: `Loaded preset "${preset.name}"` })
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to load preset "${preset.name}": ${error}`,
      })
    } finally {
      updateAppState({ disableShortCuts: false })
    }
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      return
    }
    const overwrite = presets.some((p) => p.name === trimmed)
    try {
      await savePreset(trimmed)
      setSaveOpen(false)
      setName("")
      toast({
        title: overwrite
          ? `Updated preset "${trimmed}"`
          : `Saved preset "${trimmed}"`,
      })
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to save preset "${trimmed}": ${error}`,
      })
    }
  }

  const handleDelete = async (presetName: string) => {
    try {
      await deletePreset(presetName)
      toast({ title: `Deleted preset "${presetName}"` })
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to delete preset "${presetName}": ${error}`,
      })
    }
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <IconButton
            tooltip={activePresetName ? `Preset: ${activePresetName}` : "Presets"}
          >
            {activePresetName ? (
              <BookmarkCheck className="text-primary" />
            ) : (
              <Bookmark />
            )}
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuLabel>Presets</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {presets.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              No presets saved yet
            </div>
          ) : (
            presets.map((preset) => (
              <div
                key={preset.name}
                className="flex items-center justify-between gap-1 pr-1"
              >
                <DropdownMenuItem
                  className="flex-1 cursor-pointer gap-2"
                  onSelect={() => {
                    setOpen(false)
                    applyPreset(preset.name)
                  }}
                >
                  <Check
                    size={15}
                    className={cn(
                      "shrink-0",
                      preset.name === activePresetName
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                  <span
                    className={cn(
                      preset.name === activePresetName && "font-medium"
                    )}
                  >
                    {preset.name}
                  </span>
                </DropdownMenuItem>
                <button
                  type="button"
                  aria-label={`Delete preset ${preset.name}`}
                  className="p-1 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleDelete(preset.name)
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => {
              setOpen(false)
              setName("")
              setSaveOpen(true)
            }}
          >
            <Save size={15} className="mr-2" />
            Save current as preset…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save preset</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Preset name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSave()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={name.trim().length === 0}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default PresetSelect
