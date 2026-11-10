import test from "node:test"
import assert from "node:assert/strict"
import { makePreview } from "../server/preview.mjs"
import { examples } from "../server/examples.mjs"

test("演示独有的 Tailwind 类也生成样式，避免组件通过渲染检查但视觉失真", async () => {
  const html = await makePreview({
    ...examples[0],
    demo: 'export default function Demo(){return <div className="h-[317px] bg-[#123abc]">演示样式</div>}',
  }, 15000)
  assert.match(html, /height:\s*317px/)
  assert.match(html, /18 58 188/)
})
