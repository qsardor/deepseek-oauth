const { execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const wasmOut = join(__dirname, "..", "packages", "core", "solver.wasm");
const cSrc = join(__dirname, "..", "packages", "core", "solver.c");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";

const llvmPaths = [
  ...(isWindows ? ["C:\\Program Files\\LLVM\\bin\\clang.exe"] : []),
  ...(isMac ? ["/opt/homebrew/opt/llvm/bin/clang", "/usr/local/opt/llvm/bin/clang"] : []),
  ...(isLinux ? ["/usr/bin/clang"] : []),
  "clang",
];

function findClang() {
  for (const p of llvmPaths) {
    try {
      execSync(`"${p}" --version`, { stdio: "pipe" });
      return p;
    } catch {}
  }
  return null;
}

function clangHasWasm(clangPath) {
  try {
    const result = execSync(`"${clangPath}" --target=wasm32 -E -x c /dev/null`, {
      stdio: "pipe",
      shell: true,
    });
    return !result.toString().includes("error");
  } catch (e) {
    const stderr = e.stderr?.toString() || "";
    return !stderr.includes("wasm32") && !stderr.includes("triple");
  }
}

function installLlvm() {
  console.log("[build:wasm] Installing LLVM...");

  if (isMac) {
    try {
      execSync("brew install llvm", { stdio: "inherit" });
      return true;
    } catch {
      console.warn("[build:wasm] brew install failed. Install LLVM manually: brew install llvm");
      return false;
    }
  }

  if (isLinux) {
    try {
      execSync("sudo apt-get update -qq && sudo apt-get install -y -qq clang", { stdio: "inherit" });
      return true;
    } catch {
      try {
        execSync("sudo dnf install -y clang", { stdio: "inherit" });
        return true;
      } catch {
        console.warn("[build:wasm] Could not install clang. Install manually: sudo apt install clang");
        return false;
      }
    }
  }

  if (isWindows) {
    try {
      execSync("winget install LLVM.LLVM --accept-source-agreements --accept-package-agreements --silent", {
        stdio: "inherit",
      });
      return true;
    } catch {
      console.warn("[build:wasm] winget install failed. Install LLVM manually from https://llvm.org");
      return false;
    }
  }

  return false;
}

function compile(clangPath) {
  console.log("[build:wasm] Compiling solver.c → solver.wasm");
  try {
    execSync(
      `"${clangPath}" --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export-all -o "${wasmOut}" "${cSrc}"`,
      { stdio: "pipe" },
    );
    console.log("[build:wasm] Done.");
    return true;
  } catch (e) {
    const stderr = e.stderr?.toString() || "";
    if (stderr.includes("wasm32") && stderr.includes("triple")) {
      return false;
    }
    console.warn("[build:wasm] Compilation failed. Using pre-built solver.wasm.");
    return false;
  }
}

let clang = findClang();

if (clang) {
  if (clangHasWasm(clang)) {
    compile(clang);
    process.exit(0);
  }

  if (existsSync(wasmOut)) {
    console.log("[build:wasm] Using pre-built solver.wasm");
    process.exit(0);
  }
} else {
  if (existsSync(wasmOut)) {
    console.log("[build:wasm] Using pre-built solver.wasm");
    process.exit(0);
  }
}

if (installLlvm()) {
  clang = findClang();
  if (clang && clangHasWasm(clang)) {
    compile(clang);
    process.exit(0);
  }
}

if (existsSync(wasmOut)) {
  console.log("[build:wasm] Using pre-built solver.wasm");
} else {
  console.warn("[build:wasm] WARNING: solver.wasm not found. PoW will fall back to JS.");
}
