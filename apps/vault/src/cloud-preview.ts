type PreviewDocument = {
  framework: string
  entry: string
  demo: string
  files: { path: string; content: string; encoding?: string }[]
}

// 每次编译隔离在可终止的 Worker 中，组件代码仅在 sandbox iframe 内执行。
export function compileCloudPreview(document: PreviewDocument): Promise<{ html: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./cloud-preview-worker.ts", import.meta.url), { type: "module" })
    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error("浏览器预览编译超时，请简化组件"))
    }, 30000)
    worker.onmessage = event => {
      clearTimeout(timer)
      worker.terminate()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve({ html: event.data.html })
    }
    worker.onerror = () => {
      clearTimeout(timer)
      worker.terminate()
      reject(new Error("浏览器预览编译器启动失败"))
    }
    worker.postMessage({ document, origin: location.origin })
  })
}
