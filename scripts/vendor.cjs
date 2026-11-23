const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "node_modules/dompurify");
const version = JSON.parse(fs.readFileSync(path.join(dist, "package.json"), "utf8")).version;
const files = [
  [path.join(dist, "dist/purify.es.mjs"), path.join(root, `public/vendor/dompurify-${version}.es.mjs`)],
  [path.join(dist, "LICENSE"), path.join(root, "public/vendor/DOMPurify.LICENSE")],
];
for (const [source, target] of files) {
  const expected = fs.readFileSync(source);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(target) || !expected.equals(fs.readFileSync(target))) {
      throw new Error(`Vendored DOMPurify differs from the locked package. Run npm run vendor:sync (${target}).`);
    }
  } else {
    fs.copyFileSync(source, target);
  }
}

// Vercel's CommonJS loader cannot require the ESM-only parser used by the
// current sanitize-html package. Bundle its dependencies without downgrading.
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const bundled = buildSync({
  absWorkingDir: root,
  entryPoints: ["sanitize-html"],
  outfile: "lib/vendor/sanitize-html.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "inline",
  metafile: true,
  write: false,
});
const bundledPackages = new Set(Object.keys(bundled.metafile.inputs).map((file) => {
  return file.match(/^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1];
}));
const notices = [];
for (const [directory, pkg] of Object.entries(lock.packages)) {
  if (!bundledPackages.has(directory)) continue;
  const packageDir = path.join(root, directory);
  const license = fs.readdirSync(packageDir).find(name => /^licen[sc]e(?:\.(?:txt|md))?$/i.test(name));
  if (!license) throw new Error(`Missing bundled dependency license: ${directory}`);
  const text = fs.readFileSync(path.join(packageDir, license), "utf8").replace(/[ \t]+$/gm, "");
  notices.push(`${directory} (${pkg.version})\n${text}`);
}
const banner = `/*! Server sanitizer dependency licenses\n${notices.join("\n\n").replace(/\*\//g, "* /")}\n*/\n`;
for (const file of bundled.outputFiles) {
  const contents = Buffer.concat([Buffer.from(banner), file.contents]);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file.path) || !contents.equals(fs.readFileSync(file.path))) {
      throw new Error(`Server sanitizer differs from locked dependencies. Run npm run vendor:sync (${file.path}).`);
    }
  } else {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, contents);
  }
}
const importPath = `vendor/dompurify-${version}.es.mjs`;
const importer = "public/modules/sanitize.js";
if (!fs.readFileSync(path.join(root, importer), "utf8").includes(importPath)) {
  throw new Error(`Update the DOMPurify reference in ${importer} to ${importPath}.`);
}
