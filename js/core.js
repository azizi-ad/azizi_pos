// core.js — Azizi POS (single-file, drop-in)
// Fitur utama: LocalStorage robust, waktu lokal konsisten, Intl currency, SKU unik,
// timestamp otomatis, invoice PREFIX-YYYYMM-####, seeding awal, expose global aman.
(function () {
  // ---------- Storage helpers (robust) ----------
  const storage = {
    get(key, def) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? def : JSON.parse(raw);
      } catch (e) {
        // JSON korup → bersihkan agar tidak mengganggu berikutnya
        try { localStorage.removeItem(key); } catch (_) {}
        return def;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch (e) {
        console.warn("storage.set failed for", key, e);
      }
    },
    update(key, updater, def) {
      const cur = this.get(key, def);
      const next = updater(cur);
      this.set(key, next);
      return next;
    }
  };

  // ---------- Utilities (waktu lokal konsisten, currency, escape, id) ----------
  function pad(n, len) { return String(n).padStart(len, "0"); }
  function pad2(n) { return pad(n, 2); }

  function ts() { // waktu lokal: YYYY-MM-DD HH:mm:ss
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function todayStr() { // waktu lokal: YYYY-MM-DD
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  const fmtRp = (n) =>
    new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0
    }).format(Number(n || 0));

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[m]);
  }

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
  function productById(id) {
    return DB.products.find((p) => p.id === id);
  }

  function productBySKU(sku) {
    const s = String(sku || "").trim().toLowerCase();
    return DB.products.find(
      (p) => String(p.sku || "").trim().toLowerCase() === s
    );
  }

  function saveProduct(p) {
    // Pastikan SKU unik (case-insensitive)
    if (p.sku) {
      const s = String(p.sku).trim().toLowerCase();
      const dupe = DB.products.find(
        (x) =>
          String(x.sku || "").trim().toLowerCase() === s &&
          x.id !== p.id
      );
      if (dupe) { throw new Error("SKU sudah digunakan oleh produk lain."); }
    }

    const arr = DB.products.slice();
    const i = arr.findIndex((x) => x.id === p.id);
    const now = ts();

    if (i >= 0) {
      // update
      const prev = arr[i];
      arr[i] = {
        ...prev,
        ...p,
        stock: Number(p.stock ?? prev.stock ?? 0),
        updatedAt: now
      };
    } else {
      // create
      const id = p.id || uid();
      arr.push({
        id,
        sku: p.sku || "",
        name: p.name || "",
        price: Number(p.price || 0),
        stock: Number(p.stock || 0),
        createdAt: now,
        updatedAt: now
      });
    }

    DB.products = arr;
  }

  // Hard delete (sederhana). Jika butuh audit historis, ganti ke soft delete (deletedAt).
  function deleteProduct(id) {
    DB.products = DB.products.filter((p) => p.id !== id);
  }

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

  // ---------- Invoice generator (lokal, granular bulanan) ----------
  // Format: PREFIX-YYYYMM-#### (contoh: INV-202509-0001)
  function nextInvoice() {
    const st = DB.settings ?? {};
    const prefix = String(st.invPrefix || "INV")
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, "");

    const d = new Date();
    const year = d.getFullYear();
    const month = pad2(d.getMonth() + 1); // granular bulanan

    const ic = DB.invoiceCounter ?? { year, seq: 0 };

    // Reset tahunan (lokal)
    if (ic.year !== year) {
      ic.year = year;
      ic.seq = 0;
    }

    const nextSeq = ic.seq + 1;
    const seqStr = String(nextSeq).padStart(4, "0");

    // Pilih format:
    // const number = `${prefix}-${year}-${seqStr}`; // tahunan
    const number = `${prefix}-${year}${month}-${seqStr}`; // bulanan (direkomendasikan)

    // Commit counter
    ic.seq = nextSeq;
    DB.invoiceCounter = ic;

    return number;
  }

  // ---------- Expose to global (guard agar tak menimpa jika sudah ada) ----------
  if (!window.DB) window.DB = DB;
  if (!window.core) {
    window.core = {
      // storage & utils
      storage, pad, pad2, uid, ts, fmtRp, todayStr, esc,
      // products
      productById, productBySKU, saveProduct, deleteProduct,
      // invoice
      nextInvoice
    };
  } else {
    // Jika sudah ada window.core, tambahkan/override fungsi kunci
    Object.assign(window.core, {
      storage, pad, pad2, uid, ts, fmtRp, todayStr, esc,
      productById, productBySKU, saveProduct, deleteProduct, nextInvoice
    });
  }

  // ---------- Init seed ----------
  seed();
})();
