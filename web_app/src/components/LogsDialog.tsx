import { useEffect, useRef, useState } from "react"
import { ScrollText, RefreshCw } from "lucide-react"

import { getServerLog } from "@/lib/api"
import { IconButton, Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/use-toast"

const LogsDialog = () => {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState("")
  const [path, setPath] = useState<string | null>(null)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await getServerLog(1000)
      setAvailable(res.available)
      setPath(res.path)
      setLog(res.log)
      // jump to the bottom after the DOM updates
      requestAnimationFrame(() => {
        if (preRef.current) {
          preRef.current.scrollTop = preRef.current.scrollHeight
        }
      })
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: `Failed to fetch server log: ${error}`,
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

  return (
    <>
      <IconButton tooltip="Server logs" onClick={() => setOpen(true)}>
        <ScrollText />
      </IconButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[900px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              Server logs
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

          {!available ? (
            <div className="text-sm text-muted-foreground">
              The server log is not available (the server was started without a
              log file).
            </div>
          ) : (
            <>
              {path ? (
                <div className="text-xs text-muted-foreground break-all">
                  {path}
                </div>
              ) : null}
              <pre
                ref={preRef}
                className="mt-1 h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all font-mono"
              >
                {log || "(log is empty)"}
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export default LogsDialog
