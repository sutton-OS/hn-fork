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
const notices = [];
for (const [directory, pkg] of Object.entries(lock.packages)) {
  if (!directory || pkg.dev) continue;
  const packageDir = path.join(root, directory);
  const license = fs.readdirSync(packageDir).find(name => /^licen[sc]e(?:\.(?:txt|md))?$/i.test(name));
  if (!license) throw new Error(`Missing bundled dependency license: ${directory}`);
  const text = fs.readFileSync(path.join(packageDir, license), "utf8").replace(/[ \t]+$/gm, "");
  notices.push(`${directory} (${pkg.version})\n${text}`);
}
const bundled = buildSync({
  absWorkingDir: root,
  entryPoints: ["sanitize-html"],
  outfile: "lib/vendor/sanitize-html.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  legalComments: "inline",
  banner: { js: `/*! Server sanitizer dependency licenses\n${notices.join("\n\n").replace(/\*\//g, "* /")}\n*/` },
  write: false,
});
for (const file of bundled.outputFiles) {
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(file.path) || !Buffer.from(file.contents).equals(fs.readFileSync(file.path))) {
      throw new Error(`Server sanitizer differs from locked dependencies. Run npm run vendor:sync (${file.path}).`);
    }
  } else {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.contents);
  }
}
const importPath = `vendor/dompurify-${version}.es.mjs`;
for (const file of ["public/modules/sanitize.js", "public/index.html"]) {
  if (!fs.readFileSync(path.join(root, file), "utf8").includes(importPath)) {
    throw new Error(`Update the DOMPurify reference in ${file} to ${importPath}.`);
  }
}
