const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
function checkDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkDirectory(file);
    else if (/\.(?:js|mjs|cjs)$/.test(file)) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  }
}
for (const dir of ["api", "lib", "public", "scripts", "test"]) checkDirectory(dir);
execFileSync(process.execPath, ["scripts/vendor.cjs", "--check"], { stdio: "inherit" });
