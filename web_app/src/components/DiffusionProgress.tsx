import * as React from "react"
import io from "socket.io-client"
import { Square } from "lucide-react"
import { Progress } from "./ui/progress"
import { useStore } from "@/lib/states"

export const API_ENDPOINT = import.meta.env.DEV
  ? import.meta.env.VITE_BACKEND
  : ""
const socket = io(API_ENDPOINT)

const StopButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    aria-label="Stop processing"
    title="Stop"
    onClick={onClick}
    className="shrink-0 flex h-[20px] w-[20px] items-center justify-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-destructive"
  >
    <Square size={11} className="fill-current" />
  </button>
)

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-[32px] w-[240px] items-center justify-center gap-[12px] rounded-[14px] border bg-background pl-[12px] pr-[6px] shadow-sm">
    {children}
  </div>
)

const DiffusionProgress = () => {
  const [settings, isInpainting, isSD, patchProgress, stopProcessing] =
    useStore((state) => [
      state.settings,
      state.isInpainting,
      state.isSD(),
      state.patchProgress,
      state.stopProcessing,
    ])

  const [isConnected, setIsConnected] = React.useState(false)
  const [step, setStep] = React.useState(0)

  const progress = Math.min(Math.round((step / settings.sdSteps) * 100), 100)

  React.useEffect(() => {
    socket.on("connect", () => {
      setIsConnected(true)
    })

    socket.on("disconnect", () => {
      setIsConnected(false)
    })

    socket.on("diffusion_progress", (data) => {
      if (data) {
        setStep(data.step + 1)
      }
    })

    socket.on("diffusion_finish", () => {
      setStep(0)
    })

    return () => {
      socket.off("connect")
      socket.off("disconnect")
      socket.off("diffusion_progress")
      socket.off("diffusion_finish")
    }
  }, [])

  // Per-inference denoising progress (diffusion models only).
  // Per-inference denoising progress (diffusion models only).
  const showDiffusion = isConnected && isInpainting && isSD

  // A single bar. During patch fill it shows overall tile progress, blending in
  // the current tile's denoising fraction so it fills smoothly; otherwise it
  // shows the single inference's step progress.
  let value = 0
  let label = ""
  if (patchProgress) {
    const stepFraction = showDiffusion ? Math.min(step / settings.sdSteps, 1) : 0
    value = Math.min(
      Math.round(
        ((patchProgress.done + stepFraction) / patchProgress.total) * 100
      ),
      100
    )
    label = `Patch ${patchProgress.done}/${patchProgress.total}`
  } else if (showDiffusion) {
    value = progress
    label = `${progress}%`
  }

  const visible = patchProgress !== null || showDiffusion

  return (
    <div className="fixed left-1/2 top-[68px] z-20 flex -translate-x-1/2 flex-col items-center gap-2">
      {visible ? (
        <Row>
          <Progress value={value} />
          <div className="flex w-[70px] justify-center whitespace-nowrap text-xs font-nums">
            {label}
          </div>
          <StopButton onClick={stopProcessing} />
        </Row>
      ) : null}
    </div>
  )
}

export default DiffusionProgress
