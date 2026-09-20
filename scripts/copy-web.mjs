#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, "dist", "web");
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(root, "src", "web", "console.html"), path.join(dest, "console.html"));
