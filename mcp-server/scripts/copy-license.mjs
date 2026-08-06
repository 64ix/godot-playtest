#!/usr/bin/env node
/**
 * npm only auto-includes a LICENSE file that lives inside the package
 * directory being packed/published. The repo's LICENSE lives at the repo
 * root, one level above mcp-server/ (this is a workspace-less monorepo, not
 * a package root) — so it never ships in the tarball unless copied in
 * explicitly first. Run as the "prepack" lifecycle script (spec #32,
 * criterion #2/#9: the published tarball must carry a license file).
 */
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "..", "LICENSE");
const dest = join(__dirname, "..", "LICENSE");

copyFileSync(src, dest);
