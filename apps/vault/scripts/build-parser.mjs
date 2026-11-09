import { build } from "esbuild"

// 直接打包上游解析器，保留 21st.dev 的解析行为，运行时无需安装原站服务。
await build({
  entryPoints: ["../web/lib/parsers.ts"],
  outfile: "generated/upstream-parsers.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  tsconfigRaw: {},
})
