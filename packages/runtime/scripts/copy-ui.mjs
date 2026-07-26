import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/ui", { recursive: true });
cpSync("src/ui/public", "dist/ui/public", { recursive: true });
