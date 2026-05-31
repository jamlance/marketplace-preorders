/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const stats = (r: any[]) => ({ reserved: r.filter((x) => x.state === "paid").reduce((s, x) => s + (x.qty || 1), 0), awaiting: r.filter((x) => x.state === "awaiting").length, collected: r.filter((x) => x.state === "paid").reduce((s, x) => s + Number(x.deposit || 0), 0), conversion: r.length ? Math.round((r.filter((x) => x.state === "paid").length / r.length) * 100) : 0 });
let CAMPAIGNS: any[] = [
  { id: 1, title: "Limited Fade Cream (new batch)", blurb: "Our signature styling cream — reserve the next batch.", image_url: null, product_id: null, deposit: 1000, full_price: 3500, target_qty: 50, available_on: "2026-07-01", currency: "JMD", active: true },
  { id: 2, title: "Barber Apron — Signature", blurb: "Leather-trim apron, pre-order before the drop.", image_url: null, product_id: null, deposit: 2500, full_price: 9000, target_qty: 20, available_on: null, currency: "JMD", active: true },
];
let CID = 2;
const RES: Record<number, any[]> = {
  1: [
    { id: 1, customer_name: "Maria Brown", customer_email: "maria@example.com", qty: 1, deposit: 1000, currency: "JMD", state: "paid", payment_url: "#", created_at: new Date(Date.now() - 36e5).toISOString() },
    { id: 2, customer_name: "Devon Clarke", customer_email: "devon@example.com", qty: 2, deposit: 2000, currency: "JMD", state: "awaiting", payment_url: "#", created_at: new Date(Date.now() - 72e5).toISOString() },
  ], 2: [],
};
const PRODUCTS = [
  { id: 86, title: "Afro Fade", price: 5000, currency: "JMD", image: null, units_remaining: null },
  { id: 79, title: "Colour Treatment", price: 8000, currency: "JMD", image: null, units_remaining: 12 },
  { id: 83, title: "Pomade (4oz)", price: 1500, currency: "JMD", image: null, units_remaining: 3 },
];
const ser = (c: any) => ({ ...c, ...stats(RES[c.id] || []), sold_out: Boolean(c.target_qty && stats(RES[c.id] || []).reserved >= c.target_qty), public_url: location.origin + "/preorder/" + c.id });

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 90));
    const cm = u.pathname.match(/\/api\/campaigns\/(\d+)(\/reservations)?/);

    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, can_register: true, webhook_secret_configured: true, storage: true });
    if (u.pathname === "/api/products") { const q = (u.searchParams.get("q") || "").toLowerCase(); return json({ products: PRODUCTS.filter((p) => p.title.toLowerCase().includes(q)) }); }
    if (u.pathname === "/api/upload" && method === "POST") return json({ url: "https://placehold.co/600x400/png" });
    if (u.pathname === "/api/campaigns" && method === "GET") return json({ campaigns: CAMPAIGNS.map(ser), connected: true, storage: true });
    if (u.pathname === "/api/campaigns" && method === "POST") { const c = { id: ++CID, ...body, deposit: Number(body.deposit), full_price: body.full_price ? Number(body.full_price) : null, target_qty: body.target_qty ? Number(body.target_qty) : null, currency: "JMD", active: true }; CAMPAIGNS.unshift(c); RES[CID] = []; return json({ campaign: ser(c) }, 201); }
    if (cm && cm[2] === "/reservations") return json({ reservations: RES[Number(cm[1])] || [] });
    if (cm && method === "PATCH") { const c = CAMPAIGNS.find((x) => x.id === Number(cm[1])); Object.assign(c, body); return json({ campaign: ser(c) }); }
    if (cm && method === "DELETE") { CAMPAIGNS = CAMPAIGNS.filter((x) => x.id !== Number(cm[1])); return json({ ok: true }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:read", "orders:write", "offline_access", "webhooks:manage"],
  };
}
