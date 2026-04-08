import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import fs from "node:fs";

const start = performance.now();

try {
  // Use pnpm exec to ensure TypeScript is available in PATH
  execSync("pnpm exec tsc -p tsconfig.build.json", { 
    stdio: "inherit",
    cwd: process.cwd() // Ensure we run from project root
  });

  const end = performance.now();
  const duration = ((end - start) / 1000).toFixed(2);

  // Read outDir from tsconfig.build.json with error handling
  let outDir = "(not set)";
  try {
    const tsconfigPath = path.resolve(process.cwd(), "tsconfig.build.json");
    let tsconfigContent = fs.readFileSync(tsconfigPath, "utf8");
    
    // Remove JSON comments to handle tsconfig files with comments
    tsconfigContent = tsconfigContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    
    const tsconfig = JSON.parse(tsconfigContent);

    outDir = tsconfig.compilerOptions?.outDir
      ? path.resolve(process.cwd(), tsconfig.compilerOptions.outDir)
      : "(not set)";
  } catch (configError) {
    console.warn("⚠️ Could not read tsconfig.build.json:", configError.message);
  }

  // Log build results
  console.log("");
  console.log("✅ Build successful");
  console.log(`🕒 Duration: ${duration}s`);
  console.log(`📦 Output:   ${outDir}`);
  
  // Verify output directory exists and show additional info
  if (outDir !== "(not set)" && fs.existsSync(outDir)) {
    const stats = fs.statSync(outDir);
    console.log(`📂 Size:     ${(stats.size / 1024).toFixed(2)} KB`);
  } else {
    console.log("⚠️ Output directory not found - build may have failed silently");
  }
} catch (error) {
  console.error("");
  console.error("❌ Build failed");
  
  // Provide more detailed error information
  if (error.status) {
    console.error(`Exit code: ${error.status}`);
  }
  if (error.signal) {
    console.error(`Signal: ${error.signal}`);
  }
  if (error.message && !error.message.includes("Command failed")) {
    console.error(`Error: ${error.message}`);
  }
  
  process.exit(1);
}
