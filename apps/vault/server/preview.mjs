import { Worker } from "node:worker_threads"
import { AppError } from "./model.mjs"

export const previewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
const theme =
  ":root{--background:0 0% 100%;--foreground:0 0% 9%;--primary:0 0% 9%;--primary-foreground:0 0% 98%;--secondary:0 0% 96%;--secondary-foreground:0 0% 9%;--muted:0 0% 96%;--muted-foreground:0 0% 42%;--accent:0 0% 96%;--accent-foreground:0 0% 9%;--destructive:0 72% 45%;--destructive-foreground:0 0% 98%;--border:0 0% 88%;--input:0 0% 88%;--ring:0 0% 9%;--card:0 0% 100%;--card-foreground:0 0% 9%;--popover:0 0% 100%;--popover-foreground:0 0% 9%;--radius:.5rem}body{margin:0;padding:28px;font:14px system-ui;color:#171717;background:#fff}#root{min-height:200px;display:grid;align-content:center}"
export async function makePreview(doc, timeout) {
  let content
  if (doc.framework === "html") {
    content = doc.files.find((f) => f.path === doc.entry).content
    const css = doc.files
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.content)
      .join("\n")
    content = `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>${content}`
  } else {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./preview-worker.mjs", import.meta.url),
        {
          workerData: doc,
          env: {},
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        },
      )
      const timer = setTimeout(() => {
        worker.terminate()
        reject(new AppError("预览编译超时，请简化组件", 422))
      }, timeout)
      worker.once("message", (value) => {
        clearTimeout(timer)
        worker.terminate()
        value.error ? reject(new AppError(value.error, 422)) : resolve(value)
      })
      worker.once("error", (error) => {
        clearTimeout(timer)
        reject(new AppError(`预览编译失败 ${error.message}`, 422))
      })
      worker.once("exit", (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new AppError("预览编译进程已退出", 422))
      })
    })
    content = `<style>${result.css.replace(/<\/style/gi, "<\\/style")}</style><div id="root"></div><script>${result.script.replace(/<\/script/gi, "<\\/script")}</script>`
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}</style><script>window.addEventListener('error',e=>parent.postMessage({type:'vault-preview-error',message:e.message},'*'));window.addEventListener('unhandledrejection',e=>parent.postMessage({type:'vault-preview-error',message:String(e.reason)},'*'));</script></head><body>${content}</body></html>`
}
