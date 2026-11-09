import { parentPort, workerData } from "node:worker_threads"
import { readZip } from "./importer.mjs"
import { exportZip } from "./exporter.mjs"

try {
  const result =
    workerData.kind === "import"
      ? readZip(workerData.bytes, workerData.config)
      : exportZip(
          workerData.documents,
          workerData.purpose,
          workerData.config.maxBytes,
        )
  parentPort.postMessage({ result })
} catch (error) {
  parentPort.postMessage({ error: error.message, status: error.status || 400 })
}
