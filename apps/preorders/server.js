import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[preorders] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("preorders", `
  CREATE TABLE IF NOT EXISTS campaigns (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    title TEXT NOT NULL, blurb TEXT, image_url TEXT, product_id BIGINT,
    deposit NUMERIC NOT NULL, full_price NUMERIC, target_qty INTEGER,
    available_on DATE, currency TEXT NOT NULL DEFAULT 'JMD', active BOOLEAN NOT NULL DEFAULT true,
    merchant_name TEXT, merchant_logo TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS product_id BIGINT;
  CREATE TABLE IF NOT EXISTS reservations (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, campaign_id BIGINT NOT NULL,
    customer_name TEXT, customer_email TEXT, customer_id BIGINT, qty INTEGER NOT NULL DEFAULT 1,
    ref TEXT, inkress_order_id TEXT, payment_url TEXT,
    deposit NUMERIC, currency TEXT, state TEXT NOT NULL DEFAULT 'awaiting', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS customer_id BIGINT;
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS idx_po_campaigns ON campaigns (merchant_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_po_res ON reservations (merchant_id, campaign_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
let tokens;
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { if (tokens && entry?.refreshToken) tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
tokens = await openMerchantTokens("preorders", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";

async function campaignStats(campaignId) {
  const r = await db.q(`SELECT state, qty, deposit FROM reservations WHERE campaign_id=$1`, [campaignId]);
  const paid = r.filter((x) => x.state === "paid");
  return {
    reserved: paid.reduce((s, x) => s + Number(x.qty || 1), 0),
    awaiting: r.filter((x) => x.state === "awaiting").length,
    collected: round2(paid.reduce((s, x) => s + Number(x.deposit || 0), 0)),
    conversion: r.length ? Math.round((paid.length / r.length) * 100) : 0,
  };
}
const serializeCampaign = (c, stats, req) => ({
  id: c.id, title: c.title, blurb: c.blurb, image_url: c.image_url, product_id: c.product_id ? Number(c.product_id) : null,
  deposit: Number(c.deposit), full_price: c.full_price != null ? Number(c.full_price) : null,
  target_qty: c.target_qty, available_on: c.available_on, currency: c.currency, active: c.active,
  reserved: stats?.reserved || 0, awaiting: stats?.awaiting || 0, collected: stats?.collected || 0, conversion: stats?.conversion || 0,
  sold_out: Boolean(c.target_qty && (stats?.reserved || 0) >= c.target_qty),
  public_url: `${PUBLIC_BASE(req)}/preorder/${c.id}`,
});

// ---- Catalog search (for the product picker) -------------------------------
app.get("/api/products", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `products?limit=30&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const products = (r?.result?.entries || []).map((p) => {
      const cur = p.currency || {};
      const raw = Number(p.price ?? 0);
      return {
        id: p.id, title: p.title || p.name || `Product ${p.id}`,
        price: cur.is_float === true ? raw / 100 : raw,
        currency: cur.code || req.session.data?.merchant?.currency_code || "JMD",
        image: p.image || p.images?.[0]?.url || null,
        units_remaining: p.unlimited ? null : (p.units_remaining ?? null),
      };
    });
    res.json({ products });
  } catch (err) { res.status(502).json({ error: "products_failed", message: err?.message }); }
});

// ---- Image upload (S3) -----------------------------------------------------
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "storage_off", message: "Image hosting isn't configured — paste an image URL instead." });
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return res.status(400).json({ error: "bad_image", message: "Upload a JPG, PNG, WEBP or GIF." });
  if (decoded.body.length > 5 * 1024 * 1024) return res.status(400).json({ error: "too_big", message: "Image must be under 5MB." });
  try {
    const { url } = await putObject({ prefix: `preorders/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType });
    res.json({ url });
  } catch (err) { res.status(502).json({ error: "upload_failed", message: err?.message }); }
});

// ---- Campaigns (auth) ------------------------------------------------------
app.get("/api/campaigns", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM campaigns WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const out = [];
  for (const c of rows) out.push(serializeCampaign(c, await campaignStats(c.id), req));
  res.json({ campaigns: out, connected: await tokens.hasToken(req.session.merchantId), storage: storageConfigured() });
});
app.post("/api/campaigns", core.requireSession, async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || "").trim() || !(round2(b.deposit) > 0)) return res.status(400).json({ error: "bad_input", message: "Title and a deposit amount are required." });
  const m = req.session.data?.merchant || {};
  const row = await db.one(
    `INSERT INTO campaigns (merchant_id, title, blurb, image_url, product_id, deposit, full_price, target_qty, available_on, currency, merchant_name, merchant_logo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.session.merchantId, b.title.trim(), b.blurb || null, b.image_url || null, b.product_id ? Number(b.product_id) : null,
     round2(b.deposit), b.full_price ? round2(b.full_price) : null, b.target_qty ? Number(b.target_qty) : null,
     /^\d{4}-\d{2}-\d{2}$/.test(b.available_on) ? b.available_on : null, m.currency_code || "JMD", m.name || null, m.logo || m.logo_url || null]);
  res.status(201).json({ campaign: serializeCampaign(row, { reserved: 0, awaiting: 0 }, req) });
});
// FULL edit (R1 universal editing) — every field, not just active/deposit/target/blurb.
app.patch("/api/campaigns/:id", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const c = await db.one(`SELECT * FROM campaigns WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!c) return res.status(404).json({ error: "not_found" });
  const u = await db.one(
    `UPDATE campaigns SET title=$1, blurb=$2, image_url=$3, product_id=$4, deposit=$5, full_price=$6, target_qty=$7, available_on=$8, active=$9 WHERE id=$10 RETURNING *`,
    [b.title ?? c.title, b.blurb !== undefined ? (b.blurb || null) : c.blurb, b.image_url !== undefined ? (b.image_url || null) : c.image_url,
     b.product_id !== undefined ? (b.product_id ? Number(b.product_id) : null) : c.product_id,
     b.deposit != null ? round2(b.deposit) : c.deposit, b.full_price !== undefined ? (b.full_price ? round2(b.full_price) : null) : c.full_price,
     b.target_qty !== undefined ? (b.target_qty ? Number(b.target_qty) : null) : c.target_qty,
     b.available_on !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.available_on) ? b.available_on : null) : c.available_on,
     b.active != null ? !!b.active : c.active, c.id]);
  res.json({ campaign: serializeCampaign(u, await campaignStats(c.id), req) });
});
app.delete("/api/campaigns/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM reservations WHERE campaign_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  await db.run(`DELETE FROM campaigns WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

app.get("/api/campaigns/:id/reservations", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1") {
    const awaiting = await db.q(`SELECT * FROM reservations WHERE campaign_id=$1 AND state='awaiting' AND inkress_order_id IS NOT NULL LIMIT 25`, [req.params.id]);
    for (const r of awaiting) { try { const ink = await getInkressOrder(core.cfg, req.session.accessToken, r.inkress_order_id); if (ink && isPaidStatus(ink)) await db.run(`UPDATE reservations SET state='paid' WHERE id=$1`, [r.id]); } catch { /* */ } }
  }
  const rows = await db.q(`SELECT * FROM reservations WHERE campaign_id=$1 AND merchant_id=$2 ORDER BY created_at DESC`, [req.params.id, req.session.merchantId]);
  res.json({ reservations: rows.map((r) => ({ id: r.id, customer_name: r.customer_name, customer_email: r.customer_email, customer_id: r.customer_id, qty: Number(r.qty || 1), deposit: Number(r.deposit), currency: r.currency, state: r.state, payment_url: r.payment_url, created_at: r.created_at })) });
});

// ---- Real-time status + webhook self-registration --------------------------
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const base = process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
    const url = `${base}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]);
      sub = { merchant_id: mid, url };
    } catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), webhook_secret_configured: Boolean(WEBHOOK_SECRET), storage: storageConfigured() });
});

// ---- PUBLIC reserve page ---------------------------------------------------
app.get("/preorder/:id", async (req, res) => {
  const c = await db.one(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!c || !c.active) return res.status(404).send(publicShell("Not available", `<h1>Pre-order closed</h1><p>This pre-order isn't available.</p>`));
  const stats = await campaignStats(c.id);
  res.send(reservePage(c, stats));
});
app.post("/api/public/preorder/:id", express.json(), async (req, res) => {
  const c = await db.one(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]).catch(() => null);
  if (!c || !c.active) return res.status(404).json({ error: "closed" });
  const qty = Math.max(1, Math.min(10, Math.floor(Number(req.body?.qty) || 1)));
  if (c.target_qty) { const s = await campaignStats(c.id); if (s.reserved + qty > c.target_qty) return res.status(400).json({ error: "sold_out", message: "Not enough left." }); }
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_input", message: "Enter your name and a valid email." });
  let accessToken;
  try { accessToken = await tokens.accessTokenFor(c.merchant_id); }
  catch { return res.status(503).json({ error: "not_connected", message: "This shop hasn't finished setup. Please try again later." }); }

  const total = round2(Number(c.deposit) * qty);
  const ref = `preorder-${c.merchant_id}-${c.id}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const [first, ...rest] = name.split(/\s+/);
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total, currencyCode: c.currency, kind: "online",
      title: `Pre-order deposit — ${c.title}${qty > 1 ? ` ×${qty}` : ""}`,
      customer: { email, first_name: first || "Customer", last_name: rest.join(" ") || "" },
      metaData: { source: "preorders", campaign_id: c.id, campaign: c.title, kind: "deposit", qty },
    });
  } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }

  await db.run(`INSERT INTO reservations (merchant_id, campaign_id, customer_name, customer_email, qty, ref, inkress_order_id, payment_url, deposit, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.merchant_id, c.id, name, email, qty, ref, created.id != null ? String(created.id) : null, created.payment_url || null, total, c.currency]);
  res.json({ payment_url: created.payment_url });
});

// ---- Webhook receiver (real-time deposit-paid) -----------------------------
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    await db.run(`UPDATE reservations SET state='paid' WHERE merchant_id=$1 AND inkress_order_id=$2 AND state<>'paid'`, [merchantId, String(o.id)]);
  } catch (err) { console.error(`[preorders] webhook failed: ${err?.message}`); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[preorders] listening on ${HOST}:${PORT}`));

// ---- public html -----------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } }
function publicShell(title, inner, accent = "#3b5bdb") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e9ebef;border-radius:18px;box-shadow:0 14px 44px rgba(20,25,40,.12);max-width:440px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}} .pad{padding:26px}
  .logo{width:60px;height:60px;border-radius:16px;object-fit:cover;margin:0 auto 12px;display:block;border:1px solid #eee}
  .hero{width:100%;height:200px;object-fit:cover;display:block;background:#eef0f4}
  h1{font-size:1.5rem;margin:0 0 6px;text-align:center} .blurb{color:#6b7280;text-align:center;margin:0 0 16px}
  .amt{text-align:center;font-size:2.2rem;font-weight:800;letter-spacing:-.02em;margin:4px 0} .amt small{font-size:.9rem;font-weight:600;color:#888}
  .prog{height:8px;background:#eef0f4;border-radius:99px;overflow:hidden;margin:10px 0 4px}.prog>i{display:block;height:100%;background:${accent}}
  .progt{font-size:.8rem;color:#6b7280;text-align:center;margin-bottom:16px}
  .qty{display:flex;align-items:center;justify-content:center;gap:14px;margin:12px 0}.qty button{width:38px;height:38px;border-radius:10px;border:1px solid #d4d8df;background:#fff;font-size:20px;cursor:pointer}.qty b{min-width:30px;text-align:center;font-size:18px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d4d8df;border-radius:10px;font-size:15px;margin-bottom:10px}
  button.buy{width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  .soldout{text-align:center;padding:14px;background:#fef2f2;color:#b91c1c;border-radius:10px;font-weight:700}
  .foot{text-align:center;color:#aab;font-size:12px;padding:14px}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="foot">powered by Marketplace</div></div></body></html>`;
}
function reservePage(c, stats) {
  const target = c.target_qty || 0;
  const left = target ? Math.max(0, target - stats.reserved) : null;
  const soldOut = target && stats.reserved >= target;
  const pct = target ? Math.min(100, Math.round((stats.reserved / target) * 100)) : 0;
  const hero = c.image_url ? `<img class="hero" src="${esc(c.image_url)}" alt="">` : "";
  const logo = !c.image_url && c.merchant_logo ? `<img class="logo" src="${esc(c.merchant_logo)}" alt="">` : "";
  return publicShell(`Pre-order ${c.title}`, `${hero}<div class="pad">${logo}
    <h1>${esc(c.title)}</h1>
    ${c.blurb ? `<p class="blurb">${esc(c.blurb)}</p>` : `<p class="blurb">Pre-order from ${esc(c.merchant_name || "us")}</p>`}
    <div class="amt">${money(Number(c.deposit), c.currency)} <small>deposit</small></div>
    ${c.full_price ? `<p class="blurb">Full price ${money(Number(c.full_price), c.currency)}${c.available_on ? ` · ready ${esc(String(c.available_on).slice(0, 10))}` : ""}</p>` : c.available_on ? `<p class="blurb">Ready ${esc(String(c.available_on).slice(0, 10))}</p>` : ""}
    ${target ? `<div class="prog"><i style="width:${pct}%"></i></div><div class="progt">${stats.reserved} of ${target} reserved${left != null && !soldOut ? ` · ${left} left` : ""}</div>` : ""}
    ${soldOut ? `<div class="soldout">Sold out — all reserved 🎉</div>` : `
    <div class="qty"><button id="dec">−</button><b id="q">1</b><button id="inc">+</button></div>
    <form id="f"><input id="n" required placeholder="Your name" autocomplete="name"><input id="e" type="email" required placeholder="you@email.com" autocomplete="email"><button class="buy" type="submit">Reserve with deposit</button></form>
    <div id="msg" style="display:none;color:#6b7280;text-align:center;margin-top:10px"></div>
    <script>let q=1;const qe=document.getElementById('q');document.getElementById('inc').onclick=()=>{q=Math.min(10,q+1);qe.textContent=q;};document.getElementById('dec').onclick=()=>{q=Math.max(1,q-1);qe.textContent=q;};
    document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const b=ev.target.querySelector('button');b.disabled=true;b.textContent='Creating your link…';const r=await fetch('/api/public/preorder/${c.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qty:q,name:document.getElementById('n').value,email:document.getElementById('e').value})});const j=await r.json();if(j.payment_url){window.location.href=j.payment_url;}else{b.disabled=false;b.textContent='Reserve with deposit';const m=document.getElementById('msg');m.style.display='block';m.textContent=j.message||'Something went wrong.';}});</script>`}
    </div>`);
}
