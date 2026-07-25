const { execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const wasmOut = join(__dirname, "..", "packages", "core", "solver.wasm");
const cSrc = join(__dirname, "..", "packages", "core", "solver.c");

const isWindows = process.platform === "win32";

const clangPaths = [
  ...(isWindows ? ["C:\\Program Files\\LLVM\\bin\\clang.exe"] : [
    "/opt/homebrew/opt/llvm/bin/clang",
    "/usr/local/opt/llvm/bin/clang",
  ]),
  "clang",
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
    console.log("[build:wasm] Using pre-built solver.wasm (install LLVM to recompile)");
  } else {
    console.warn("[build:wasm] WARNING: solver.wasm not found and no compiler available. PoW falls back to JS.");
  }
  process.exit(0);
}

console.log("[build:wasm] Compiling solver.c → solver.wasm");

try {
  execSync(
    `"${clang}" --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export-all -o "${wasmOut}" "${cSrc}"`,
    { stdio: "pipe" },
  );
  console.log("[build:wasm] Done.");
} catch (e) {
  const stderr = e.stderr?.toString() || "";

  if (stderr.includes("wasm32") && stderr.includes("triple")) {
    console.log("[build:wasm] Using pre-built solver.wasm (this clang lacks wasm32 — install LLVM to recompile)");
  } else {
    console.warn("[build:wasm] Compilation failed. Using pre-built solver.wasm.");
  }
}
