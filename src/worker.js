/**
 * 内裤/内衣进销存 —— Cloudflare Worker 后端
 * 静态页面由 assets 提供，/api/* 由本文件处理，数据落在 D1。
 */

const KINDS = {
  styles: { table: "styles" },
  stock: { table: "stock" },
  bills: { table: "bills" },
  materials: { table: "materials" },
  meta: { table: "meta" },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" },
  });

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS styles (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS stock (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, ts INTEGER, date TEXT, type TEXT, data TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, data TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_bills_ts ON bills (ts DESC)"),
  ]);
  schemaReady = true;
}

/** 口令校验：未设置 APP_PIN 时不鉴权（仅建议内网/临时使用） */
function authed(request, env) {
  const pin = (env.APP_PIN || "").trim();
  if (!pin) return true;
  return (request.headers.get("x-pin") || "").trim() === pin;
}

/** 解析 "styles/abc" -> {kind, id} */
function parsePath(path) {
  if (typeof path !== "string") return null;
  const i = path.indexOf("/");
  if (i < 1) return null;
  const kind = path.slice(0, i);
  const id = path.slice(i + 1);
  if (!KINDS[kind] || !id || id.includes("/") || id.length > 120) return null;
  return { kind, id };
}

async function readAll(env) {
  const [styles, stock, bills, materials, meta] = await env.DB.batch([
    env.DB.prepare("SELECT data FROM styles"),
    env.DB.prepare("SELECT id, data FROM stock"),
    env.DB.prepare("SELECT data FROM bills ORDER BY ts DESC LIMIT 2000"),
    env.DB.prepare("SELECT data FROM materials"),
    env.DB.prepare("SELECT id, data FROM meta"),
  ]);
  const parse = (rows) => rows.results.map((r) => JSON.parse(r.data));
  const stockMap = {};
  for (const r of stock.results) {
    const v = JSON.parse(r.data);
    stockMap[v.styleId || r.id] = v.q || {};
  }
  const cfgRow = meta.results.find((r) => r.id === "cfg");
  return {
    styles: parse(styles),
    stock: stockMap,
    bills: parse(bills),
    materials: parse(materials),
    cfg: cfgRow ? JSON.parse(cfgRow.data) : null,
  };
}

async function put(env, kind, id, obj) {
  const data = JSON.stringify(obj);
  if (data.length > 900000) throw new Error("document too large");
  if (kind === "bills") {
    await env.DB.prepare(
      "INSERT INTO bills (id, ts, date, type, data) VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, date=excluded.date, type=excluded.type, data=excluded.data"
    )
      .bind(id, Number(obj.ts) || Date.now(), String(obj.date || ""), String(obj.type || ""), data)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO ${KINDS[kind].table} (id, data${kind === "meta" ? "" : ", updated"}) VALUES (?1, ?2${kind === "meta" ? "" : ", ?3"}) ` +
        `ON CONFLICT(id) DO UPDATE SET data=excluded.data${kind === "meta" ? "" : ", updated=excluded.updated"}`
    )
      .bind(...(kind === "meta" ? [id, data] : [id, data, Date.now()]))
      .run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // 交给静态资源（public/index.html）
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }
    if (!env.DB) return json({ error: "D1 数据库未绑定，请检查 wrangler.toml" }, 500);

    const route = url.pathname.slice(5);
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);

    try {
      await ensureSchema(env);

      if (route === "all" && request.method === "GET") {
        return json(await readAll(env));
      }

      if (route === "put" && request.method === "POST") {
        const { path, obj } = await request.json();
        const p = parsePath(path);
        if (!p || typeof obj !== "object" || obj === null) return json({ error: "bad request" }, 400);
        await put(env, p.kind, p.id, obj);
        return json({ ok: true });
      }

      if (route === "del" && request.method === "POST") {
        const { path } = await request.json();
        const p = parsePath(path);
        if (!p) return json({ error: "bad request" }, 400);
        await env.DB.prepare(`DELETE FROM ${KINDS[p.kind].table} WHERE id = ?1`).bind(p.id).run();
        return json({ ok: true });
      }

      if (route === "wipe" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body.confirm) return json({ error: "need confirm" }, 400);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM styles"),
          env.DB.prepare("DELETE FROM stock"),
          env.DB.prepare("DELETE FROM bills"),
          env.DB.prepare("DELETE FROM materials"),
        ]);
        return json({ ok: true });
      }

      // 整库备份：GET /api/backup
      if (route === "backup" && request.method === "GET") {
        const all = await readAll(env);
        return new Response(JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), data: all }, null, 1), {
          headers: {
            "content-type": "application/json;charset=utf-8",
            "content-disposition": `attachment; filename="inv-backup-${new Date().toISOString().slice(0, 10)}.json"`,
          },
        });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
