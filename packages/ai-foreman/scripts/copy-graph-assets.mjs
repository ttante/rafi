import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../dist/graph/", import.meta.url), { recursive: true });
copyFileSync(new URL("../src/graph/bridge.py", import.meta.url), new URL("../dist/graph/bridge.py", import.meta.url));
