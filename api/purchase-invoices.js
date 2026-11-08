// 進項發票：列表、新增（存資料庫並上傳 ERP）、重新上傳 ERP
import {
  sql, json, checkAccess, ensureTable, normalizeInvoice, pushToErp,
} from '../lib/invoice.js';

async function saveErpResult(id, result) {
  const [row] = await sql`
    UPDATE purchase_invoices
    SET erp_status = ${result.status}, erp_message = ${result.message}
    WHERE id = ${id}
    RETURNING *`;
  return row;
}

// 最近 50 張
export async function GET(request) {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    await ensureTable();
    const rows = await sql`
      SELECT * FROM purchase_invoices
      ORDER BY created_at DESC
      LIMIT 50`;
    return json(rows);
  } catch (err) {
    console.error(err);
    return json({ error: '讀取發票失敗，請稍後再試。' }, 500);
  }
}

// body 為發票欄位 → 新增；body 為 { retry_id } → 重新上傳該張到 ERP
export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '資料格式錯誤。' }, 400);
  }

  try {
    await ensureTable();

    if (body?.retry_id !== undefined) {
      const id = Number(body.retry_id);
      if (!Number.isInteger(id)) return json({ error: '發票編號錯誤。' }, 400);
      const [inv] = await sql`SELECT * FROM purchase_invoices WHERE id = ${id}`;
      if (!inv) return json({ error: '找不到這張發票。' }, 404);
      if (inv.erp_status === 'synced') return json(inv);
      return json(await saveErpResult(id, await pushToErp(inv)));
    }

    const { invoice: inv, error } = normalizeInvoice(body);
    if (error) return json({ error }, 400);

    const [row] = await sql`
      INSERT INTO purchase_invoices (
        invoice_number, invoice_date, invoice_type, seller_tax_id, seller_name,
        buyer_tax_id, buyer_name, tax_type, deductible, sales_amount,
        tax_amount, total_amount, items, notes
      ) VALUES (
        ${inv.invoice_number}, ${inv.invoice_date}, ${inv.invoice_type},
        ${inv.seller_tax_id}, ${inv.seller_name}, ${inv.buyer_tax_id},
        ${inv.buyer_name}, ${inv.tax_type}, ${inv.deductible},
        ${inv.sales_amount}, ${inv.tax_amount}, ${inv.total_amount},
        ${JSON.stringify(inv.items)}, ${inv.notes}
      )
      ON CONFLICT (invoice_number) DO NOTHING
      RETURNING *`;
    if (!row) return json({ error: `發票 ${inv.invoice_number} 已經登錄過了。` }, 409);

    return json(await saveErpResult(row.id, await pushToErp(inv)), 201);
  } catch (err) {
    console.error(err);
    return json({ error: '儲存發票失敗，請稍後再試。' }, 500);
  }
}
