import { useCallback, useEffect, useRef } from "react"

import useInputImage from "@/hooks/useInputImage"
import { keepGUIAlive } from "@/lib/utils"
import { getMediaFile, getMedias, getServerConfig } from "@/lib/api"
import Header from "@/components/Header"
import Workspace from "@/components/Workspace"
import FileSelect from "@/components/FileSelect"
import { Toaster } from "./components/ui/toaster"
import { useStore } from "./lib/states"
import { useWindowSize } from "react-use"

const SUPPORTED_FILE_TYPE = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
]
function Home() {
  const [
    file,
    isRestoringSession,
    updateAppState,
    setServerConfig,
    setFile,
    restoreSession,
  ] = useStore((state) => [
    state.file,
    state.isRestoringSession,
    state.updateAppState,
    state.setServerConfig,
    state.setFile,
    state.restoreSession,
  ])

  const userInputImage = useInputImage()

  const windowSize = useWindowSize()

  useEffect(() => {
    if (userInputImage) {
      setFile(userInputImage)
    }
  }, [userInputImage, setFile])

  useEffect(() => {
    updateAppState({ windowSize })
  }, [windowSize])

  useEffect(() => {
    const fetchServerConfig = async () => {
      const serverConfig = await getServerConfig()
      setServerConfig(serverConfig)
      if (serverConfig.isDesktop) {
        // Keeping GUI Window Open
        keepGUIAlive()
      }
      // Silently restore a persisted edit session (image + history) so a reload
      // after a transient failure doesn't lose work. Must run *before* the
      // preload below and be awaited: the preload always picks the first input
      // image, which would otherwise clobber (and clear) a session for a
      // different one.
      const restored = await restoreSession()
      if (restored) {
        return
      }
      // When running with a file browser (e.g. the darktable integration), preload
      // the first input image so a single-image session opens ready to edit instead
      // of requiring the user to open the file browser first.
      if (serverConfig.enableFileManager) {
        try {
          const medias = await getMedias("input")
          if (medias.length > 0) {
            const f = await getMediaFile("input", medias[0].name)
            setFile(f)
          }
        } catch (e) {
          // ignore: the user can still pick an image from the file browser
        }
      }
    }
    fetchServerConfig()
  }, [])

  const dragCounter = useRef(0)

  const handleDrag = useCallback((event: any) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleDragIn = useCallback((event: any) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current += 1
  }, [])

  const handleDragOut = useCallback((event: any) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounter.current -= 1
    if (dragCounter.current > 0) return
  }, [])

  const handleDrop = useCallback((event: any) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      if (event.dataTransfer.files.length > 1) {
        // setToastState({
        //   open: true,
        //   desc: "Please drag and drop only one file",
        //   state: "error",
        //   duration: 3000,
        // })
      } else {
        const dragFile = event.dataTransfer.files[0]
        const fileType = dragFile.type
        if (SUPPORTED_FILE_TYPE.includes(fileType)) {
          setFile(dragFile)
        } else {
          // setToastState({
          //   open: true,
          //   desc: "Please drag and drop an image file",
          //   state: "error",
          //   duration: 3000,
          // })
        }
      }
      event.dataTransfer.clearData()
    }
  }, [])

  const onPaste = useCallback((event: any) => {
    // TODO: when sd side panel open, ctrl+v not work
    // https://htmldom.dev/paste-an-image-from-the-clipboard/
    if (!event.clipboardData) {
      return
    }
    const clipboardItems = event.clipboardData.items
    const items: DataTransferItem[] = [].slice
      .call(clipboardItems)
      .filter((item: DataTransferItem) => {
        // Filter the image items only
        return item.type.indexOf("image") !== -1
      })

    if (items.length === 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    // TODO: add confirm dialog

    const item = items[0]
    // Get the blob of image
    const blob = item.getAsFile()
    if (blob) {
      setFile(blob)
    }
  }, [])

  useEffect(() => {
    window.addEventListener("dragenter", handleDragIn)
    window.addEventListener("dragleave", handleDragOut)
    window.addEventListener("dragover", handleDrag)
    window.addEventListener("drop", handleDrop)
    window.addEventListener("paste", onPaste)
    return function cleanUp() {
      window.removeEventListener("dragenter", handleDragIn)
      window.removeEventListener("dragleave", handleDragOut)
      window.removeEventListener("dragover", handleDrag)
      window.removeEventListener("drop", handleDrop)
      window.removeEventListener("paste", onPaste)
    }
  })

  return (
    <main className="flex min-h-screen flex-col items-center justify-between w-full bg-[radial-gradient(circle_at_1px_1px,_#8e8e8e8e_1px,_transparent_0)] [background-size:20px_20px] bg-repeat">
      <Toaster />
      <Header />
      <Workspace />
      {!file && !isRestoringSession ? (
        <FileSelect
          onSelection={async (f) => {
            setFile(f)
          }}
        />
      ) : (
        <></>
      )}
    </main>
  )
}

export default Home
