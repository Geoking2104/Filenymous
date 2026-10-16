import { build } from "esbuild";
import { readFileSync, chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));
const out = resolve(here, "dist/filenymous.js");

await build({
  entryPoints: [resolve(here, "src/cli.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  // Native/optional deps stay external (installed from npm).
  external: ["node-datachannel", "node-datachannel/*", "ws", "bufferutil", "utf-8-validate"],
  plugins: [{
    // The web app's ui/src/p2p code is bundled as-is; only the device label is swapped.
    name: "cli-device",
    setup(b) {
      b.onResolve({ filter: /^\.\/device$/ }, (args) => args.importer.includes("/ui/src/p2p/") ? { path: resolve(here, "src/device.ts") } : undefined);
    },
  }],
});
chmodSync(out, 0o755);
console.log(`built ${out} (${(statSync(out).size / 1024).toFixed(1)} KiB)`);
