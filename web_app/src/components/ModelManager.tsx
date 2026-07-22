import { useEffect, useState } from "react"
import { Boxes, Check, Download, Loader2, RefreshCw } from "lucide-react"

import { useStore } from "@/lib/states"
import {
  ModelEntry,
  downloadModel,
  getModels,
  switchModel,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import { IconButton, Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

const formatSize = (bytes: number, estimate: boolean) => {
  if (!bytes) {
    return "—"
  }
  const gb = bytes / 1024 / 1024 / 1024
  const text =
    gb >= 1
      ? `${gb.toFixed(1)} GB`
      : `${Math.round(bytes / 1024 / 1024)} MB`
  return estimate ? `~${text}` : text
}

const ModelManager = () => {
  const { toast } = useToast()
  const [settings, serverConfig, setModel, maybeAutoEnableCropper, updateAppState] =
    useStore((state) => [
      state.settings,
      state.serverConfig,
      state.setModel,
      state.maybeAutoEnableCropper,
      state.updateAppState,
    ])

  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // model name in flight
  const [hfId, setHfId] = useState("")

  const currentName = settings.model.name

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await getModels()
      setModels(res.models)
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to list models: ${error}`,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const useModelByName = async (name: string) => {
    if (name === currentName) {
      return
    }
    setBusy(name)
    updateAppState({ disableShortCuts: true })
    try {
      const newModel = await switchModel(name)
      setModel(newModel)
      // Oversized image + a diffusion model → auto-enable & size the cropper.
      maybeAutoEnableCropper()
      toast({ title: `Switched to ${newModel.name}` })
      setOpen(false)
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to switch to ${name}: ${error} — see Server logs`,
      })
    } finally {
      updateAppState({ disableShortCuts: false })
      setBusy(null)
    }
  }

  const handleDownload = async (name: string) => {
    setBusy(name)
    try {
      await downloadModel(name)
      toast({ title: `Downloaded ${name}` })
      await refresh()
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to download ${name}: ${error} — see Server logs`,
      })
    } finally {
      setBusy(null)
    }
  }

  const renderRow = (m: ModelEntry) => {
    const isCurrent = m.name === currentName
    const inFlight = busy === m.name
    return (
      <div
        key={m.name}
        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isCurrent ? (
              <Check size={15} className="shrink-0 text-primary" />
            ) : null}
            <span
              className={cn("truncate", isCurrent && "font-medium")}
              title={m.name}
            >
              {m.name}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {m.downloaded ? "Downloaded" : "Not downloaded"} ·{" "}
            {formatSize(m.size_bytes, m.size_is_estimate)}
          </div>
        </div>

        {!m.needs_download ? (
          <span className="text-xs text-muted-foreground">built-in</span>
        ) : m.downloaded ? (
          <Button
            variant={isCurrent ? "secondary" : "outline"}
            size="sm"
            className="h-8 shrink-0"
            disabled={isCurrent || inFlight || serverConfig.disableModelSwitch}
            onClick={() => useModelByName(m.name)}
          >
            {inFlight ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isCurrent ? (
              "In use"
            ) : (
              "Use"
            )}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1"
            disabled={inFlight}
            onClick={() => handleDownload(m.name)}
          >
            {inFlight ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Download
          </Button>
        )}
      </div>
    )
  }

  const erase = models.filter((m) => m.family === "erase")
  const diffusion = models.filter((m) => m.family === "diffusion")

  return (
    <>
      <IconButton tooltip="Models" onClick={() => setOpen(true)}>
        <Boxes />
      </IconButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              Models
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                Refresh
              </Button>
            </DialogTitle>
          </DialogHeader>

          {busy ? (
            <div className="text-xs text-muted-foreground">
              Working on “{busy}”… large downloads can take a while; watch
              progress in <span className="font-medium">Server logs</span>.
            </div>
          ) : null}

          <div className="max-h-[60vh] overflow-auto flex flex-col gap-4 pr-1">
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-muted-foreground">
                Erase models (fast, no prompt)
              </div>
              {erase.map(renderRow)}
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-muted-foreground">
                Diffusion models (prompt-based, need a GPU)
              </div>
              {diffusion.map(renderRow)}
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-muted-foreground">
                Download another model
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="HuggingFace model id, e.g. org/model-inpainting"
                  value={hfId}
                  onChange={(e) => setHfId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hfId.trim()) {
                      handleDownload(hfId.trim())
                    }
                  }}
                />
                <Button
                  variant="outline"
                  className="shrink-0 gap-1"
                  disabled={hfId.trim().length === 0 || busy !== null}
                  onClick={() => handleDownload(hfId.trim())}
                >
                  <Download size={14} />
                  Download
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default ModelManager
