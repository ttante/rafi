// Live probe (M2 plan 10.8 b): loopback listen and connect, and a public connect.
import net from "node:net"; import { mkdirSync, writeFileSync } from "node:fs"; import path from "node:path";
const connect = (host, port) => new Promise((done) => { const s = net.connect({ host, port, timeout: 5000 });
  s.on("connect", () => { s.destroy(); done("connected"); }); s.on("timeout", () => { s.destroy(); done("timeout"); });
  s.on("error", (e) => done(e.code ?? e.message)); });
const loopback = await new Promise((done) => { const srv = net.createServer((c) => c.end());
  srv.on("error", (e) => done({ listen: e.code ?? e.message }));
  srv.listen(0, "127.0.0.1", async () => { const r = await connect("127.0.0.1", srv.address().port); srv.close();
    done({ listen: "ok", connect: r }); }); });
const text = JSON.stringify({ loopback, public: await connect("1.1.1.1", 443) });
for (const dir of [process.env.TMPDIR, "probe-out"]) { try { mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "probe-net.json"), text); } catch {} }
console.log(text);
