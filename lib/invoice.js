// 進項發票共用工具：存取驗證、資料表、欄位檢查、上傳 ERP
import { createHash, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

export function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// 發票是公司資料，所有 API 都要帶 x-access-key（= 環境變數 INVOICE_ACCESS_KEY）
// 回傳 null 表示通過，否則回傳錯誤 Response
export function checkAccess(request) {
  const expected = process.env.INVOICE_ACCESS_KEY;
  if (!expected) {
    return json({ error: '伺服器尚未設定 INVOICE_ACCESS_KEY，發票功能已停用。' }, 503);
  }
  const given = request.headers.get('x-access-key') ?? '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    return json({ error: '存取密碼錯誤。' }, 401);
  }
  return null;
}

let ready;
export function ensureTable() {
  ready ??= sql`
    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id             SERIAL PRIMARY KEY,
      invoice_number VARCHAR(10)  NOT NULL UNIQUE,
      invoice_date   DATE         NOT NULL,
      invoice_type   VARCHAR(20)  NOT NULL,
      seller_tax_id  VARCHAR(8)   NOT NULL DEFAULT '',
      seller_name    VARCHAR(100) NOT NULL DEFAULT '',
      buyer_tax_id   VARCHAR(8)   NOT NULL DEFAULT '',
      buyer_name     VARCHAR(100) NOT NULL DEFAULT '',
      tax_type       VARCHAR(10)  NOT NULL,
      deductible     BOOLEAN      NOT NULL DEFAULT true,
      sales_amount   NUMERIC(14,2) NOT NULL,
      tax_amount     NUMERIC(14,2) NOT NULL,
      total_amount   NUMERIC(14,2) NOT NULL,
      items          JSONB        NOT NULL DEFAULT '[]',
      notes          VARCHAR(500) NOT NULL DEFAULT '',
      erp_status     VARCHAR(20)  NOT NULL DEFAULT 'pending',
      erp_message    TEXT         NOT NULL DEFAULT '',
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
    )`.catch(err => { ready = undefined; throw err; });
  return ready;
}

export const INVOICE_TYPES = ['三聯式', '二聯式', '電子發票', '收銀機三聯式', '收銀機二聯式', '其他'];
export const TAX_TYPES = ['應稅', '零稅率', '免稅'];

// 驗證並整理表單送來的資料；有錯誤時回傳 { error }
export function normalizeInvoice(body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = v => {
    const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };

  const inv = {
    invoice_number: str(body?.invoice_number, 20).toUpperCase().replace(/[\s-]/g, ''),
    invoice_date: str(body?.invoice_date, 10),
    invoice_type: str(body?.invoice_type, 20),
    seller_tax_id: str(body?.seller_tax_id, 8),
    seller_name: str(body?.seller_name, 100),
    buyer_tax_id: str(body?.buyer_tax_id, 8),
    buyer_name: str(body?.buyer_name, 100),
    tax_type: str(body?.tax_type, 10),
    deductible: body?.deductible !== false,
    sales_amount: num(body?.sales_amount),
    tax_amount: num(body?.tax_amount),
    total_amount: num(body?.total_amount),
    notes: str(body?.notes, 500),
    items: [],
  };

  if (!/^[A-Z]{2}\d{8}$/.test(inv.invoice_number)) {
    return { error: '發票號碼格式應為 2 個英文字母 + 8 位數字（例如 AB12345678）。' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date) || Number.isNaN(Date.parse(inv.invoice_date))) {
    return { error: '請填寫正確的發票日期。' };
  }
  if (!INVOICE_TYPES.includes(inv.invoice_type)) return { error: '請選擇發票種類。' };
  if (!TAX_TYPES.includes(inv.tax_type)) return { error: '請選擇課稅別。' };
  if (inv.seller_tax_id && !/^\d{8}$/.test(inv.seller_tax_id)) return { error: '賣方統編需為 8 位數字。' };
  if (inv.buyer_tax_id && !/^\d{8}$/.test(inv.buyer_tax_id)) return { error: '買方統編需為 8 位數字。' };
  for (const k of ['sales_amount', 'tax_amount', 'total_amount']) {
    if (Number.isNaN(inv[k]) || inv[k] < 0) return { error: '金額欄位需為正確的數字。' };
  }
  if (Math.abs(inv.sales_amount + inv.tax_amount - inv.total_amount) > 1) {
    return { error: '銷售額 + 稅額 與 總計 不符，請再確認。' };
  }

  if (Array.isArray(body?.items)) {
    for (const it of body.items.slice(0, 100)) {
      const item = {
        description: str(it?.description, 200),
        quantity: num(it?.quantity),
        unit_price: num(it?.unit_price),
        amount: num(it?.amount),
      };
      if (!item.description) continue;
      for (const k of ['quantity', 'unit_price', 'amount']) {
        if (Number.isNaN(item[k])) item[k] = null;
      }
      inv.items.push(item);
    }
  }
  return { invoice: inv };
}

// 把發票送到 ERP（erp.top-geng.com）的「進項發票」
// 需要設定 ERP_API_TOKEN（和 ERP 的 INVOICE_API_TOKEN 相同）；ERP_API_URL 可不設，預設送到 erp.top-geng.com
const DEFAULT_ERP_URL = 'https://erp.top-geng.com/api/purchase-invoices';

function toErpPayload(inv, photo) {
  // 從資料庫讀出的 DATE 可能是 Date 物件
  const date = inv.invoice_date instanceof Date
    ? inv.invoice_date.toISOString().slice(0, 10)
    : String(inv.invoice_date).slice(0, 10);
  const note = [inv.buyer_name ? `買方：${inv.buyer_name}` : '', inv.notes].filter(Boolean).join('\n');
  return {
    invoice_no: inv.invoice_number,
    invoice_date: date,
    invoice_type: inv.invoice_type,
    tax_type: inv.tax_type,
    deductible: inv.deductible,
    seller_tax_id: inv.seller_tax_id,
    seller_name: inv.seller_name,
    buyer_tax_id: inv.buyer_tax_id,
    sales_amount: Number(inv.sales_amount),
    tax_amount: Number(inv.tax_amount),
    total: Number(inv.total_amount),
    items: (inv.items || []).map(i => ({ name: i.description, qty: i.quantity, unit_price: i.unit_price, amount: i.amount })),
    create_supplier: true, // ERP 找不到這個統編的廠商時自動新增
    note,
    ...(photo ? { photo } : {}),
  };
}

// 回傳 { status: 'synced' | 'failed' | 'not_configured', message }
export async function pushToErp(inv, photo = null) {
  const token = process.env.ERP_API_TOKEN;
  if (!token) {
    return { status: 'not_configured', message: '尚未設定 ERP_API_TOKEN，資料只存在本站。' };
  }
  try {
    const res = await fetch(process.env.ERP_API_URL || DEFAULT_ERP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(toErpPayload(inv, photo)),
      signal: AbortSignal.timeout(20000),
    });
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON 回應 */ }
    if (res.ok) return { status: 'synced', message: `ERP 進項發票 #${data.id ?? ''}` };
    // 已經在 ERP 裡（例如上次其實送成功但逾時）就算已上傳
    if (res.status === 409) return { status: 'synced', message: data.error || 'ERP 已有這張發票。' };
    return { status: 'failed', message: `ERP 回應 ${res.status}：${data.error || '未知錯誤'}` };
  } catch (err) {
    return { status: 'failed', message: `無法連線到 ERP：${err.message}` };
  }
}
