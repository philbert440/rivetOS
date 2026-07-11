#!/usr/bin/env node
// Extract arm64 .deb archives into a staging dir without running dpkg (needs no root/zstd).
// Uses fzstd for noble's data.tar.zst members when dpkg-deb -x is unavailable.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const fzstd = require("fzstd");

const [stageDir, ...debPaths] = process.argv.slice(2);
if (!stageDir || debPaths.length === 0) {
  console.error("usage: extract-debs.mjs <stageDir> <deb>...");
  process.exit(2);
}

function extractDeb(debPath, outDir) {
  const buf = fs.readFileSync(debPath);
  let pos = 8;
  while (pos < buf.length) {
    const name = buf.subarray(pos, pos + 16).toString("ascii").trim();
    const size = parseInt(buf.subarray(pos + 48, pos + 58).toString("ascii").trim(), 10);
    pos += 60;
    const data = buf.subarray(pos, pos + size);
    pos += size;
    if (size & 1) pos++;
    if (!name.startsWith("data.tar")) continue;
    const raw = name.endsWith(".zst") ? Buffer.from(fzstd.decompress(data)) : data;
    const tarPath = path.join(outDir, `${path.basename(debPath)}.data.tar`);
    fs.writeFileSync(tarPath, raw);
    execSync(`tar xf ${JSON.stringify(tarPath)} -C ${JSON.stringify(outDir)}`, { stdio: "pipe" });
    fs.unlinkSync(tarPath);
    return;
  }
  throw new Error(`no data.tar member in ${debPath}`);
}

fs.mkdirSync(stageDir, { recursive: true });
for (const deb of debPaths) extractDeb(deb, stageDir);