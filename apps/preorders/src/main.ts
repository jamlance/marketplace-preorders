import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Campaign { id: number; title: string; blurb: string | null; image_url: string | null; product_id: number | null; deposit: number; full_price: number | null; target_qty: number | null; available_on: string | null; currency: string; active: boolean; reserved: number; awaiting: number; collected: number; conversion: number; sold_out: boolean; public_url: string; }
interface Reservation { id: number; customer_name: string | null; customer_email: string | null; qty: number; deposit: number; currency: string; state: string; payment_url: string | null; created_at: string; }
interface ProductHit { id: number; title: string; price: number; currency: string; image: string | null; units_remaining: number | null; }
interface Status { realtime: boolean; webhook_registered: boolean; can_register: boolean; webhook_secret_configured: boolean; storage: boolean; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let campaigns: Campaign[] = [];
let resCampaign = 0;
let resFilter = "";
let resSearch = "";
let canStore = false;
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "box",
    brandLogo: "/logo.svg",
    title: "Pre-orders",
    subtitle: `${merchantName} · sell it before it's in stock`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "campaigns", label: "Campaigns", icon: "box", render: renderCampaigns },
      { id: "reservations", label: "Reservations", icon: "list", render: renderReservations },
    ],
  });
})();

/* ----------------------------------------------------------------- Campaigns */
async function renderCampaigns(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { campaigns: Campaign[]; connected: boolean; storage: boolean };
  let status: Status | null = null;
  try {
    [data, status] = await Promise.all([
      bvApi<{ campaigns: Campaign[]; connected: boolean; storage: boolean }>("/api/campaigns"),
      bvApi<Status>("/api/status").catch(() => null as any),
    ]);
    campaigns = data.campaigns; canStore = data.storage;
  } catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  if (status && !status.realtime) host.append(h("div", { class: "po-note bv-muted" }, iconEl("clock", 14), "Finishing setup — paid reservations confirm automatically once connected."));

  host.append(statRow([
    { k: "Campaigns", v: String(campaigns.length), icon: "box" },
    { k: "Reserved", v: String(campaigns.reduce((s, c) => s + c.reserved, 0)), tone: "ok", icon: "check" },
    { k: "Collected", v: fmtMoney(campaigns.reduce((s, c) => s + c.collected, 0), currency), tone: "accent", icon: "coins" },
    { k: "Awaiting", v: String(campaigns.reduce((s, c) => s + c.awaiting, 0)), icon: "clock" },
  ]));

  const add = h("button", { class: "primary", onClick: () => openCampaign(null) }, iconEl("plus", 15), "New pre-order");
  if (!campaigns.length) { host.append(card({ title: "Pre-orders", action: add, body: emptyState({ icon: "box", title: "No pre-orders yet", text: "Create one, then share its public link — customers reserve with a deposit." }) })); return; }

  const grid = h("div", { class: "po-grid" });
  for (const c of campaigns) {
    const target = c.target_qty || 0;
    const pct = target ? Math.min(100, Math.round((c.reserved / target) * 100)) : 0;
    grid.append(h("div", { class: "po-card" + (c.active ? "" : " is-off") },
      c.image_url ? h("img", { class: "po-img", src: c.image_url, alt: "" }) : h("div", { class: "po-img po-img-ph" }, iconEl("box", 28)),
      h("div", { class: "po-body" },
        h("div", { class: "po-head" }, h("strong", null, c.title), c.sold_out ? pill("sold out", "bad") : c.active ? null : pill("paused")),
        h("div", { class: "po-deposit" }, fmtMoney(c.deposit, c.currency), h("span", { class: "bv-muted" }, " deposit"), c.full_price ? h("span", { class: "bv-muted" }, ` · ${fmtMoney(c.full_price, c.currency)} full`) : null),
        target ? h("div", null, h("div", { class: "po-prog" }, h("i", { style: { width: `${pct}%` } })), h("div", { class: "bv-muted po-progt" }, `${c.reserved} of ${target} reserved · ${fmtMoney(c.collected, c.currency)} collected`)) : h("div", { class: "bv-muted po-progt" }, `${c.reserved} reserved · ${fmtMoney(c.collected, c.currency)} collected`),
        h("div", { class: "po-link" }, h("input", { class: "po-link-input", readonly: true, value: c.public_url }), h("button", { class: "ghost sm", title: "Copy link", onClick: () => { navigator.clipboard?.writeText(c.public_url); flash("Public link copied", "success"); } }, iconEl("copy", 14))),
        h("div", { class: "po-actions" },
          h("button", { class: "ghost sm", onClick: () => { resCampaign = c.id; shell.select("reservations"); } }, `${c.reserved + c.awaiting} reservation${c.reserved + c.awaiting === 1 ? "" : "s"}`),
          h("a", { class: "po-open", href: c.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 14)),
          h("button", { class: "ghost sm", onClick: () => openCampaign(c) }, iconEl("edit", 14)),
          h("button", { class: "ghost sm", onClick: async () => { await bvApi(`/api/campaigns/${c.id}`, { method: "DELETE" }); shell.select("campaigns"); } }, iconEl("trash", 14))))));
  }
  host.append(card({ title: "Pre-orders", action: add, body: grid }));
  if (!data.connected) host.append(h("div", { class: "po-note bv-muted" }, iconEl("alert", 14), "Finishing connection to your Inkress account — public reservations activate momentarily."));
}

function openCampaign(c: Campaign | null) {
  const title = h("input", { value: c?.title || "", placeholder: "e.g. Limited Edition Hoodie" }) as HTMLInputElement;
  const blurb = h("input", { value: c?.blurb || "", placeholder: "Short description (optional)" }) as HTMLInputElement;
  const deposit = h("input", { type: "number", min: "0", step: "0.01", value: c ? String(c.deposit) : "", placeholder: "0.00" }) as HTMLInputElement;
  const full = h("input", { type: "number", min: "0", step: "0.01", value: c?.full_price != null ? String(c.full_price) : "", placeholder: "optional" }) as HTMLInputElement;
  const target = h("input", { type: "number", min: "1", value: c?.target_qty != null ? String(c.target_qty) : "", placeholder: "optional" }) as HTMLInputElement;
  const avail = h("input", { type: "date", value: c?.available_on?.slice(0, 10) || "" }) as HTMLInputElement;
  const image = h("input", { value: c?.image_url || "", placeholder: "Image URL — or upload below" }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: c ? c.active : true }) as HTMLInputElement;
  let productId: number | null = c?.product_id ?? null;

  const preview = h("span", { class: "po-thumb" + (c?.image_url ? "" : " is-empty"), style: c?.image_url ? { backgroundImage: `url('${c.image_url}')` } : {} });
  const setImg = (url: string) => { image.value = url; preview.className = "po-thumb"; preview.style.backgroundImage = `url('${url}')`; };
  image.addEventListener("input", () => { if (image.value) setImg(image.value); });
  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" } }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast("Image must be under 5MB", "warning"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try { const r = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: reader.result }) }); setImg(r.url); flash("Image uploaded", "success"); }
      catch (err: any) { toast(err?.message || "Upload failed", "error"); }
    };
    reader.readAsDataURL(f);
  });
  const uploadBtn = h("button", { class: "ghost sm", disabled: !canStore, title: canStore ? "" : "Image hosting not configured — paste a URL", onClick: () => fileInput.click() }, iconEl("download", 14), "Upload");

  const prodSearch = h("input", { placeholder: "Link an Inkress product (optional) — search…", autocomplete: "off" }) as HTMLInputElement;
  const prodResults = h("div", { class: "po-prodresults", style: { display: "none" } });
  const linked = h("div", { class: "po-linked" });
  const renderLinked = () => { linked.innerHTML = ""; if (productId) linked.append(h("span", { class: "bv-muted" }, `Linked product #${productId} `), h("button", { class: "ghost sm", onClick: () => { productId = null; renderLinked(); } }, "Unlink")); };
  renderLinked();
  let pt: any;
  prodSearch.addEventListener("input", () => { clearTimeout(pt); const q = prodSearch.value.trim(); if (q.length < 2) { prodResults.style.display = "none"; return; }
    pt = setTimeout(async () => {
      try { const { products } = await bvApi<{ products: ProductHit[] }>(`/api/products?q=${encodeURIComponent(q)}`);
        prodResults.innerHTML = ""; if (!products.length) { prodResults.style.display = "none"; return; }
        for (const p of products) prodResults.append(h("div", { class: "po-prodrow", onClick: () => {
          productId = p.id; if (!title.value) title.value = p.title; if (p.image) setImg(p.image); if (p.price && !full.value) full.value = String(p.price);
          prodResults.style.display = "none"; prodSearch.value = ""; renderLinked();
        } }, p.image ? h("span", { class: "po-prodthumb", style: { backgroundImage: `url('${p.image}')` } }) : h("span", { class: "po-prodthumb is-empty" }), h("div", null, h("strong", null, p.title), h("div", { class: "bv-muted" }, fmtMoney(p.price, p.currency)))));
        prodResults.style.display = "block";
      } catch { prodResults.style.display = "none"; }
    }, 220); });

  const body = h("div", { class: "po-form" },
    field("Title", title), field("Description", blurb),
    h("div", { class: "po-imgrow" }, preview, h("div", { style: { flex: "1" } }, field("Image", image), h("div", { class: "po-imgbtns" }, uploadBtn, fileInput))),
    h("label", { class: "po-field" }, h("span", { class: "bv-label" }, "Link a product"), prodSearch, prodResults, linked),
    h("div", { class: "po-form-grid" }, field("Deposit", deposit), field("Full price", full), field("Target qty", target), field("Available on", avail)),
    c ? h("label", { class: "po-check" }, active, " Active (accepting reservations)") : null);

  const save = async () => {
    if (!title.value.trim() || !(Number(deposit.value) > 0)) { toast("Title and deposit are required", "warning"); return; }
    const payload: any = { title: title.value, blurb: blurb.value, image_url: image.value || null, product_id: productId, deposit: Number(deposit.value), full_price: full.value || null, target_qty: target.value || null, available_on: avail.value || null };
    try {
      if (c) { payload.active = active.checked; await bvApi(`/api/campaigns/${c.id}`, { method: "PATCH", body: JSON.stringify(payload) }); }
      else await bvApi("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
      flash(c ? "Saved" : "Pre-order created", "success"); shell.select("campaigns");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: c ? "Edit pre-order" : "New pre-order", body, actions: [{ label: c ? "Save" : "Create", primary: true, onClick: () => { void save(); } }] });
}

/* -------------------------------------------------------------- Reservations */
async function renderReservations(host: HTMLElement) {
  if (!campaigns.length) { try { campaigns = (await bvApi<{ campaigns: Campaign[] }>("/api/campaigns")).campaigns; } catch { /* */ } }
  if (!campaigns.length) { host.append(emptyState({ icon: "list", title: "No campaigns", text: "Create a pre-order first." })); return; }
  if (!resCampaign || !campaigns.find((c) => c.id === resCampaign)) resCampaign = campaigns[0]!.id;

  const picker = h("select", { onChange: (e: any) => { resCampaign = Number(e.target.value); shell.select("reservations"); } },
    ...campaigns.map((c) => h("option", { value: String(c.id), selected: c.id === resCampaign }, c.title))) as HTMLSelectElement;
  const searchInput = h("input", { class: "po-search", placeholder: "Search name/email…", value: resSearch }) as HTMLInputElement;
  let st: any; searchInput.addEventListener("input", () => { clearTimeout(st); st = setTimeout(() => { resSearch = searchInput.value; paint(); }, 200); });

  const body = h("div");
  host.append(card({ title: "Reservations", action: h("div", { class: "po-restools" }, picker, searchInput), body }));
  body.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let all: Reservation[];
  try { all = (await bvApi<{ reservations: Reservation[] }>(`/api/campaigns/${resCampaign}/reservations?refresh=1`)).reservations; }
  catch (err: any) { body.innerHTML = ""; body.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }

  function filtered() {
    const q = resSearch.trim().toLowerCase();
    return all.filter((r) => (!resFilter || r.state === resFilter) && (!q || `${r.customer_name ?? ""} ${r.customer_email ?? ""}`.toLowerCase().includes(q)));
  }
  function paint() {
    body.innerHTML = "";
    const chips = h("div", { class: "po-filters" }, ...([["", "All"], ["paid", "Paid"], ["awaiting", "Awaiting"]] as [string, string][]).map(([v, l]) =>
      h("button", { class: "po-filter" + (resFilter === v ? " is-on" : ""), onClick: () => { resFilter = v; paint(); } }, l)));
    const exportBtn = h("button", { class: "ghost sm", onClick: () => exportCsv(filtered()) }, iconEl("download", 14), "Export CSV");
    const rows = filtered();
    body.append(h("div", { class: "po-resbar" }, chips, exportBtn));
    body.append(rows.length ? dataTable<Reservation>({
      columns: [
        { head: "Customer", cell: (r) => h("div", null, h("strong", null, r.customer_name || "—"), r.customer_email ? h("div", { class: "bv-muted" }, r.customer_email) : null) },
        { head: "Qty", num: true, cell: (r) => String(r.qty) },
        { head: "Deposit", num: true, cell: (r) => fmtMoney(r.deposit, r.currency) },
        { head: "State", cell: (r) => pill(r.state, r.state === "paid" ? "ok" : "warn") },
        { head: "When", cell: (r) => h("span", { class: "bv-muted" }, relTime(r.created_at)) },
      ], rows,
    }) : emptyState({ icon: "inbox", title: "No reservations", text: "Share the public link to start taking deposits." }));
  }
  paint();
}

function exportCsv(rows: Reservation[]) {
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["customer,email,qty,deposit,currency,state,created_at"];
  for (const r of rows) lines.push([r.customer_name, r.customer_email, r.qty, r.deposit, r.currency, r.state, r.created_at].map(esc).join(","));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `reservations-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); flash(`Exported ${rows.length}`, "success");
}

/* -------------------------------------------------------------------- helpers */
function field(label: string, el: HTMLElement) { return h("label", { class: "po-field" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Pre-orders couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
