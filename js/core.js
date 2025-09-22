// core.js — Azizi POS (single-file, drop-in)
// Fitur utama: LocalStorage robust, waktu lokal konsisten, Intl currency, SKU unik,
// timestamp otomatis, invoice PREFIX-YYYYMM-####, seeding awal, expose global aman,
// + Mobile/Responsive helpers (viewport, vh fix, safe-area, env flags).
(function () {
  // ---------- Storage helpers (robust) ----------
  const storage = {
    get(key, def) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? def : JSON.parse(raw);
      } catch (e) {
        try { localStorage.removeItem(key); } catch (_) {}
        return def;
      }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { console.warn("storage.set failed for", key, e); }
    },
    update(key, updater, def) {
      const cur = this.get(key, def);
      const next = updater(cur);
      this.set(key, next);
      return next;
    }
  };

  // ---------- Utilities (waktu lokal konsisten, currency, escape, id) ----------
  const pad = (n, len) => String(n).padStart(len, "0");
  const pad2 = (n) => pad(n, 2);

  function ts() { // waktu lokal: YYYY-MM-DD HH:mm:ss
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function todayStr() { // waktu lokal: YYYY-MM-DD
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const fmtRp = (n) => new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0
  }).format(Number(n || 0));
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[m]);
  }
  const debounce = (fn, ms=120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

  // ---------- DB keys & getters/setters ----------
  const DB = {
    productsKey: "az_pos_products",
    salesKey: "az_pos_sales",
    movesKey: "az_pos_moves",
    settingsKey: "az_pos_settings",
    invoiceKey: "az_pos_invoice_counter",
    cashKey: "az_pos_cash_sessions",

    get products() { return storage.get(this.productsKey, []); },
    set products(v) { storage.set(this.productsKey, v); },

    get sales() { return storage.get(this.salesKey, []); },
    set sales(v) { storage.set(this.salesKey, v); },

    get moves() { return storage.get(this.movesKey, []); },
    set moves(v) { storage.set(this.movesKey, v); },

    get settings() {
      return storage.get(this.settingsKey, {
        storeName: "Azizi Cell",
        storeAddr: "",
        storeFooter: "Terima kasih!",
        invPrefix: "INV",
        taxDefault: 0
      });
    },
    set settings(v) { storage.set(this.settingsKey, v); },

    get invoiceCounter() {
      const d = new Date();
      return storage.get(this.invoiceKey, { year: d.getFullYear(), seq: 0 });
    },
    set invoiceCounter(v) { storage.set(this.invoiceKey, v); },

    get cash() { return storage.get(this.cashKey, { open: null, history: [] }); },
    set cash(v) { storage.set(this.cashKey, v); }
  };

  // ---------- Product helpers ----------
  const productById = (id) => DB.products.find((p) => p.id === id);
  function productBySKU(sku) {
    const s = String(sku || "").trim().toLowerCase();
    return DB.products.find((p) => String(p.sku || "").trim().toLowerCase() === s);
  }
  function saveProduct(p) {
    // SKU unik (case-insensitive)
    if (p.sku) {
      const s = String(p.sku).trim().toLowerCase();
      const dupe = DB.products.find((x) => String(x.sku || "").trim().toLowerCase() === s && x.id !== p.id);
      if (dupe) throw new Error("SKU sudah digunakan oleh produk lain.");
    }
    const arr = DB.products.slice();
    const i = arr.findIndex((x) => x.id === p.id);
    const now = ts();

    if (i >= 0) {
      const prev = arr[i];
      arr[i] = { ...prev, ...p, stock: Number(p.stock ?? prev.stock ?? 0), updatedAt: now };
    } else {
      const id = p.id || uid();
      arr.push({
        id, sku: p.sku || "", name: p.name || "",
        price: Number(p.price || 0), stock: Number(p.stock || 0),
        createdAt: now, updatedAt: now
      });
    }
    DB.products = arr;
  }
  const deleteProduct = (id) => { DB.products = DB.products.filter((p) => p.id !== id); };

  // ---------- Seeder (idempotent saat kosong) ----------
  function seed() {
    if (DB.products.length === 0) {
      const now = ts();
      DB.products = [
        { id: uid(), sku: "SKU001", name: "Kartu Perdana",  price: 15000, stock: 20, createdAt: now, updatedAt: now },
        { id: uid(), sku: "SKU002", name: "Charger Type-C", price: 75000, stock: 10, createdAt: now, updatedAt: now },
        { id: uid(), sku: "SKU003", name: "Headset",        price: 50000, stock: 12, createdAt: now, updatedAt: now },
        { id: uid(), sku: "SKU004", name: "Tempered Glass", price: 20000, stock: 30, createdAt: now, updatedAt: now }
      ];
    }
  }

  // ---------- Invoice generator (lokal, bulanan) ----------
  // Format: PREFIX-YYYYMM-#### (contoh: INV-202509-0001)
  function nextInvoice() {
    const st = DB.settings ?? {};
    const prefix = String(st.invPrefix || "INV").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const d = new Date();
    const year = d.getFullYear();
    const month = pad2(d.getMonth() + 1);

    const ic = DB.invoiceCounter ?? { year, seq: 0 };
    if (ic.year !== year) { ic.year = year; ic.seq = 0; }

    const nextSeq = ic.seq + 1;
    const seqStr = String(nextSeq).padStart(4, "0");
    const number = `${prefix}-${year}${month}-${seqStr}`;

    ic.seq = nextSeq;
    DB.invoiceCounter = ic;
    return number;
  }

  // ========== Mobile / Responsive Helpers ==========
  // 1) Pastikan <meta name="viewport"> ada
  (function ensureViewportMeta(){
    const content = "width=device-width, initial-scale=1, viewport-fit=cover";
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) { m = document.createElement("meta"); m.name = "viewport"; m.content = content; document.head.appendChild(m); }
    else if (!/viewport-fit=cover/.test(m.content)) { m.content = content; }
  })();

  // 2) Env & flags
  const UA = navigator.userAgent || "";
  const env = {
    isTouch: ("ontouchstart" in window) || (navigator.maxTouchPoints > 0),
    isMobileUA: /Android|iPhone|iPad|iPod|Mobile|Silk|IEMobile|BlackBerry/i.test(UA),
    get isMobile(){ return this.isMobileUA || Math.min(window.innerWidth, window.innerHeight) <= 768; },
    platform: /Android/i.test(UA) ? "android" :
              /iPhone|iPad|iPod/i.test(UA) ? "ios" :
              /Windows/i.test(UA) ? "windows" :
              /Mac/i.test(UA) ? "mac" : "other",
    get vw(){ return window.innerWidth; },
    get vh(){ return window.innerHeight; },
    colorScheme: (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"
  };

  // Apply classes to <html>
  const html = document.documentElement;
  html.classList.toggle("is-touch", env.isTouch);
  html.classList.toggle("no-touch", !env.isTouch);
  html.classList.toggle("is-mobile", env.isMobile);
  html.classList.toggle("is-desktop", !env.isMobile);
  html.classList.add(`platform-${env.platform}`);

  // 3) Fix 100vh di mobile: set --vh = 1% dari innerHeight
  function setVHVar(){
    const vh = window.innerHeight * 0.01;
    html.style.setProperty("--vh", `${vh}px`);
  }
  setVHVar();
  window.addEventListener("resize", debounce(() => {
    const wasMobile = html.classList.contains("is-mobile");
    setVHVar();
    html.classList.toggle("is-mobile", env.isMobile);
    html.classList.toggle("is-desktop", !env.isMobile);
    if (wasMobile !== env.isMobile) window.dispatchEvent(new Event("core:mobile-toggle"));
  }));
  window.addEventListener("orientationchange", setVHVar, { passive: true });

  // 4) Safe area (untuk notch / dynamic island)
  function computeSafeArea(){
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const px = (v) => Number(String(v).replace("px","")) || 0;
    const res = { top:px(cs.paddingTop), right:px(cs.paddingRight), bottom:px(cs.paddingBottom), left:px(cs.paddingLeft) };
    probe.remove();
    html.style.setProperty("--safe-top",    res.top + "px");
    html.style.setProperty("--safe-right",  res.right + "px");
    html.style.setProperty("--safe-bottom", res.bottom + "px");
    html.style.setProperty("--safe-left",   res.left + "px");
    return res;
  }
  const safeArea = computeSafeArea();

  // 5) Helpers untuk UI
  const mobile = {
    ensureViewportMeta: () => {}, // sudah dijalankan
    refreshMetrics(){
      setVHVar(); computeSafeArea();
      html.classList.toggle("is-mobile", env.isMobile);
      html.classList.toggle("is-desktop", !env.isMobile);
    },
    onResponsiveChange(fn){
      const handler = debounce(()=>fn({ vw: env.vw, vh: env.vh, isMobile: env.isMobile }), 120);
      window.addEventListener("resize", handler);
      return ()=>window.removeEventListener("resize", handler);
    },
    // Set input angka agar keyboard HP numeric:
    enhanceNumericInputs(root = document){
      root.querySelectorAll('input[type="number"], input[data-numeric]').forEach(el=>{
        el.setAttribute("inputmode","numeric");
        el.setAttribute("enterkeyhint","done");
        // optional: hilangkan scroll pada number di desktop
        el.addEventListener("wheel", (e)=>{ e.target.blur(); }, { passive:false });
      });
    }
  };

  // ---------- Expose to global ----------
  if (!window.DB) window.DB = DB;
  if (!window.core) window.core = {};
  Object.assign(window.core, {
    // storage & utils
    storage, pad, pad2, uid, ts, fmtRp, todayStr, esc,
    // products
    productById, productBySKU, saveProduct, deleteProduct,
    // invoice
    nextInvoice,
    // env & mobile helpers
    env, mobile, safeArea
  });

  // ---------- Init ----------
  seed();
  // Default: aktifkan numeric keyboard untuk input angka jika ada
  document.addEventListener("DOMContentLoaded", () => {
    mobile.enhanceNumericInputs(document);
  });
})();
