import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate"
import { openStore } from "../server/store.mjs"
import { loadConfig } from "../server/config.mjs"
import { validateComponent } from "../server/model.mjs"
import { analyze, readZip, readRegistry } from "../server/importer.mjs"
import { isPublicAddress } from "../server/remote.mjs"
import { exportZip, planExport, promptFor } from "../server/exporter.mjs"
import { makePreview } from "../server/preview.mjs"
import { examples } from "../server/examples.mjs"

const config = loadConfig({ VAULT_PASSWORD: "test-only-password-123" })
const component = (index = 1) =>
  validateComponent(
    { ...examples[0], slug: `sample-${index}`, name: `样例 ${index}` },
    config.maxBytes,
  )

test("配置校验包括密码、来源和范围", () => {
  assert.throws(() => loadConfig({}), /VAULT_PASSWORD/)
  assert.throws(
    () =>
      loadConfig({
        VAULT_PASSWORD: "test-only-password-123",
        VAULT_ORIGIN: "https://example.com/path",
      }),
    /VAULT_ORIGIN/,
  )
  assert.throws(
    () =>
      loadConfig({
        VAULT_PASSWORD: "test-only-password-123",
        VAULT_MAX_PAGE_SIZE: "9999",
      }),
    /VAULT_MAX_PAGE_SIZE/,
  )
})
test("复用上游解析器识别导出和 npm 依赖", () => {
  const result = analyze(
    "import {motion} from 'motion/react'; export function Button(){return null}",
  )
  assert.deepEqual(result.exports, ["Button"])
  assert.equal(result.dependencies.motion, "latest")
})
test("分页、空数据、稳定排序、原子导入、版本并发和组件集快照", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vault-store-"))
  const store = openStore(directory)
  try {
    assert.equal(store.list({ size: 2 }).total, 0)
    const docs = store.createMany([component(1), component(2), component(3)])
    const first = store.list({ size: 2, page: 1 })
    const second = store.list({ size: 2, page: 2 })
    assert.equal(first.items.length, 2)
    assert.equal(second.items.length, 1)
    assert.equal(
      new Set([...first.items, ...second.items].map((d) => d.id)).size,
      3,
    )
    assert.deepEqual(store.list({ size: 2, page: 1 }).items, first.items)
    assert.equal(store.list({ size: 2, page: 3 }).items.length, 0)
    assert.equal(store.list({ query: "样例 1", size: 2 }).total, 1)
    assert.throws(
      () => store.createMany([component(4), component(1)]),
      /已存在/,
    )
    assert.equal(store.list({ size: 2 }).total, 3)
    const kit = store.saveKit("后台组件", [{ id: docs[0].id, revision: 1 }])
    store.update(docs[0].id, { ...component(1), name: "改名" }, 1)
    assert.equal(store.get(docs[0].id).revision, 2)
    assert.equal(store.kit(kit.id).items[0].name, "样例 1")
    assert.equal(store.get(docs[0].id, 1).name, "样例 1")
    assert.throws(() => store.update(docs[0].id, component(1), 1), /刷新/)
    assert.equal(store.versions(docs[0].id).length, 2)
    store.db.close()
    const reopened = openStore(directory)
    assert.equal(reopened.get(docs[0].id).revision, 2)
    reopened.db.close()
  } finally {
    try {
      store.db.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})
test("文件路径、ZIP 路径穿越和解压上限", () => {
  assert.throws(
    () =>
      validateComponent(
        { ...component(), entry: "../button.tsx" },
        config.maxBytes,
      ),
    /入口|路径/,
  )
  const traversal = zipSync({ "../outside.txt": strToU8("x") })
  assert.throws(() => readZip(traversal, config), /路径/)
  const bomb = zipSync({ "huge.txt": new Uint8Array(2048) })
  assert.throws(() => readZip(bomb, { ...config, maxBytes: 1024 }), /上限/)
  assert.throws(
    () => readZip(zipSync({ "button.tsx": strToU8("x") }), config),
    /component.json/,
  )
  const good = zipSync({
    "component.json": strToU8(
      JSON.stringify({ ...component(), files: undefined }),
    ),
    "button.tsx": strToU8(component().files[0].content),
  })
  assert.equal(readZip(good, config)[0].slug, "sample-1")
})
test("多组件源码包可重新导入，提示词包含源码", () => {
  const docs = examples.map((d, i) => ({
    ...validateComponent(d, config.maxBytes),
    id: `id-${i}`,
    revision: 1,
  }))
  const zip = exportZip(docs, "创建管理页面")
  const files = unzipSync(zip)
  const imported = readZip(zip, config)
  assert.equal(imported.length, 4)
  assert.equal(
    imported[0].files.find((f) => f.path === docs[0].entry).content,
    docs[0].files[0].content,
  )
  assert.ok(files["public/components/inline-subscribe/preview.html"])
  assert.match(strFromU8(files["AGENT.md"]), /创建管理页面/)
  assert.match(promptFor(docs), /export function Button/)
  assert.equal(
    JSON.parse(strFromU8(files["package.json"])).dependencies.react,
    "19.1.0",
  )
})
test("导出拒绝依赖冲突和缺失别名文件", () => {
  assert.throws(
    () => planExport([{ ...component(), dependencies: { react: "18.3.1" } }]),
    /冲突/,
  )
  const doc = {
    ...component(),
    files: [
      {
        path: "button.tsx",
        content: "import X from '@/missing'; export default X",
      },
    ],
  }
  assert.throws(() => exportZip([doc]), /缺少/)
})
test("公网地址校验拒绝本机、私网、保留和 IPv4 映射地址", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("8.8.8.8"), true)
  await assert.rejects(
    () => readRegistry("http://localhost/component.json", config),
    /HTTPS/,
  )
  await assert.rejects(
    () => readRegistry("https://127.0.0.1/component.json", config),
    /公网/,
  )
})
test("全部内置组件真实编译，缺失依赖明确报错", async () => {
  for (const doc of examples) {
    const html = await makePreview(doc, 15000)
    assert.match(html, /Content-Security-Policy/)
    assert.match(html, /connect-src 'none'/)
  }
  await assert.rejects(
    () =>
      makePreview(
        {
          ...component(),
          files: [
            {
              path: "button.tsx",
              content: "import X from 'uninstalled-package'; export default X",
            },
          ],
        },
        15000,
      ),
    /尚未安装/,
  )
})

test("递归 Registry 导入保留依赖、标准路径与主题，拒绝损坏或冲突", async () => {
  const root = "https://example.com/r/card.json"
  const fixtures = {
    [root]: {
      name: "demo-card",
      files: [
        {
          path: "card.tsx",
          content:
            "import {Button} from '@/components/ui/button';export default function Card(){return <Button/>}",
        },
      ],
      dependencies: ["clsx@2.1.1"],
      registryDependencies: ["button"],
      cssVars: { light: { brand: "0 0% 10%" } },
    },
    "https://example.com/r/button.json": {
      name: "button",
      files: [
        {
          path: "registry/new-york/ui/button.tsx",
          type: "registry:ui",
          content: "export function Button(){return <button>测试</button>}",
        },
      ],
      cssVars: { dark: { brand: "0 0% 90%" } },
    },
  }
  const doc = await readRegistry(root, config, {}, async (url) => fixtures[url])
  assert.equal(doc.dependencies.clsx, "2.1.1")
  assert.ok(doc.files.find((file) => file.path === "components/ui/button.tsx"))
  assert.match(
    doc.files.find((file) => file.path === "registry-theme.css").content,
    /\.dark/,
  )
  assert.match(await makePreview(doc, 15000), /Content-Security-Policy/)
  await assert.rejects(
    () => readRegistry(root, config, {}, async () => ({ files: [{}] })),
    /格式无效/,
  )
  await assert.rejects(
    () =>
      readRegistry(root, config, {}, async () => {
        throw new Error("network failure")
      }),
    /网络/,
  )
  const conflict = structuredClone(fixtures)
  conflict["https://example.com/r/button.json"].cssVars = {
    light: { brand: "0 0% 50%" },
  }
  await assert.rejects(
    () => readRegistry(root, config, {}, async (url) => conflict[url]),
    /冲突/,
  )
})
