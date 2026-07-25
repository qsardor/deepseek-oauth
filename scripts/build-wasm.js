const { execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const wasmOut = join(__dirname, "..", "packages", "core", "solver.wasm");
const cSrc = join(__dirname, "..", "packages", "core", "solver.c");

const clangPaths = [
  "clang",
  "clang.exe",
  "/usr/bin/clang",
  "/usr/local/bin/clang",
  "C:\\Program Files\\LLVM\\bin\\clang.exe",
];

function findClang() {
  for (const p of clangPaths) {
    try {
      execSync(`"${p}" --version`, { stdio: "pipe" });
      return p;
    } catch {}
  }
  return null;
}

const clang = findClang();

if (!clang) {
  if (existsSync(wasmOut)) {
    console.log("[build:wasm] Using pre-built solver.wasm (clang not found — install LLVM to recompile)");
  } else {
    console.warn("[build:wasm] WARNING: solver.wasm not found and clang is not available. PoW will fall back to JS.");
  }
  process.exit(0);
}

console.log("[build:wasm] Compiling solver.c → solver.wasm with", clang);

try {
  execSync(
    `"${clang}" --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export-all -o "${wasmOut}" "${cSrc}"`,
    { stdio: "inherit" },
  );
  console.log("[build:wasm] Done.");
} catch {
  console.warn("[build:wasm] Compilation failed. Using pre-built solver.wasm if available.");
  process.exit(0);
}
