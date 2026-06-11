import { useEffect } from "react"
import Editor from "./Editor"
import { currentModel } from "@/lib/api"
import { useStore } from "@/lib/states"
import ImageSize from "./ImageSize"
import Plugins from "./Plugins"
import PatchFill from "./PatchFill"
import { InteractiveSeg } from "./InteractiveSeg"
import SidePanel from "./SidePanel"
import DiffusionProgress from "./DiffusionProgress"

const Workspace = () => {
  const [file, updateSettings] = useStore((state) => [
    state.file,
    state.updateSettings,
  ])

  useEffect(() => {
    const fetchCurrentModel = async () => {
      const model = await currentModel()
      updateSettings({ model })
    }
    fetchCurrentModel()
  }, [])

  return (
    <>
      <div className="flex gap-3 absolute top-[68px] left-[24px] items-center z-20">
        <Plugins />
        <ImageSize />
        {file ? <PatchFill /> : <></>}
      </div>
      <InteractiveSeg />
      <DiffusionProgress />
      <SidePanel />
      {file ? <Editor file={file} /> : <></>}
    </>
  )
}

export default Workspace
