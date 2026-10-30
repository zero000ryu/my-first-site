import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const NAME_MAX = 30;
const MESSAGE_MAX = 200;

// 第一次被呼叫時建立資料表，之後同一個執行個體就不再重複建立
// （DDL 不能用參數，所以長度直接寫死，需與上方常數一致）
let ready;
function ensureTable() {
  ready ??= sql`
    CREATE TABLE IF NOT EXISTS guestbook (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(30)  NOT NULL,
      message    VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.catch(err => { ready = undefined; throw err; });
  return ready;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// 讀取最新 50 則留言
export async function GET() {
  try {
    await ensureTable();
    const rows = await sql`
      SELECT id, name, message, created_at
      FROM guestbook
      ORDER BY created_at DESC
      LIMIT 50`;
    return json(rows);
  } catch (err) {
    console.error(err);
    return json({ error: '讀取留言失敗，請稍後再試。' }, 500);
  }
}

// 新增一則留言
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '資料格式錯誤。' }, 400);
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';

  if (!name || !message) {
    return json({ error: '請填寫名字和留言。' }, 400);
  }
  if ([...name].length > NAME_MAX || [...message].length > MESSAGE_MAX) {
    return json({ error: `名字最多 ${NAME_MAX} 字，留言最多 ${MESSAGE_MAX} 字。` }, 400);
  }

  try {
    await ensureTable();
    const [row] = await sql`
      INSERT INTO guestbook (name, message)
      VALUES (${name}, ${message})
      RETURNING id, name, message, created_at`;
    return json(row, 201);
  } catch (err) {
    console.error(err);
    return json({ error: '留言送出失敗，請稍後再試。' }, 500);
  }
}
