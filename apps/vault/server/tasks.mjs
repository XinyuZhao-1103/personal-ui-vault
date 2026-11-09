import { Worker } from "node:worker_threads"
import { AppError } from "./model.mjs"

let running = false
export async function archiveTask(input, config) {
  if (running) throw new AppError("另一个打包任务正在运行，请稍后重试", 429)
  running = true
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./tasks-worker.mjs", import.meta.url),
        {
          workerData: {
            ...input,
            config: {
              maxBytes: config.maxBytes,
              maxSelection: config.maxSelection,
            },
          },
          env: {},
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        },
      )
      const timer = setTimeout(() => {
        worker.terminate()
        reject(new AppError("组件包处理超时，请分批操作", 422))
      }, config.previewTimeout)
      worker.once("message", (value) => {
        clearTimeout(timer)
        worker.terminate()
        value.error
          ? reject(new AppError(value.error, value.status))
          : resolve(value.result)
      })
      worker.once("error", () => {
        clearTimeout(timer)
        reject(new AppError("组件包处理失败，请检查文件或减少组件数量", 422))
      })
      worker.once("exit", (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new AppError("组件包处理已终止", 422))
      })
    })
  } finally {
    running = false
  }
}
