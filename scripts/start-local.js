const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "assets", "react-ui", "loading-buttons.js");

if (!fs.existsSync(bundle)) {
  console.log("[REVEX] Building React LoadingButton bundle...");
  const binName = process.platform === "win32" ? "vite.cmd" : "vite";
  const candidates = [
    path.join(root, "node_modules", ".bin", binName),
    path.join(root, "backend", "node_modules", ".bin", binName),
  ];
  const viteBin = candidates.find(fs.existsSync);
  if (!viteBin) {
    console.error("[REVEX] Vite is not installed. Run `npm install` from the project root or from `backend`, then retry.");
    process.exit(1);
  }
  const result = spawnSync(viteBin, ["build", "--config", "react-ui/vite.config.ts"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

require(path.join(root, "backend", "server.js"));
