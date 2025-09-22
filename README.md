# Azizi POS — Paket #1 (CORE)

Ini adalah inti aplikasi POS offline (HTML+CSS+JS). Paket ini berisi:
- `index.html` (redirect ke `dashboard.html`)
- `css/style.css` (tema gelap + komponen umum)
- `js/core.js` (Database LocalStorage + helper)

> Paket halaman (Dashboard, Produk, POS, dst.) dapat diekstrak menyusul ke folder **azizi_pos/** yang sama.

## Cara pakai
1. Ekstrak ZIP ini. Pastikan struktur folder menjadi `azizi_pos/`.
2. Tambahkan paket halaman lain (#2 s/d #8) ke folder yang sama (overwrite bila diminta).
3. Buka `azizi_pos/index.html` di browser.

## Catatan
- Data disimpan di LocalStorage per-browser/per-perangkat.
- Nomor faktur berformat `PREFIX-YYYY-0001` dan reset setiap pergantian tahun.
