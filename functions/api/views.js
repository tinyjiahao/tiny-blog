const JSON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function normalizePostPath(value) {
  if (typeof value !== 'string') return null;

  let path;
  try {
    path = decodeURI(value.trim());
  } catch {
    return null;
  }

  if (
    path.length > 512 ||
    path.includes('?') ||
    path.includes('#') ||
    !/^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/$/.test(path)
  ) {
    return null;
  }

  return path;
}

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: '请求体必须是 JSON' }, 400);
  }

  const path = normalizePostPath(payload?.path);
  if (!path) {
    return json({ error: '文章路径无效' }, 400);
  }

  try {
    const row = await context.env.BLOG_VIEWS_DB
      .prepare(`
        INSERT INTO post_views (path, views, created_at, updated_at)
        VALUES (?1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET
          views = post_views.views + 1,
          updated_at = CURRENT_TIMESTAMP
        RETURNING views
      `)
      .bind(path)
      .first();

    if (!row || !Number.isSafeInteger(row.views)) {
      throw new Error('D1 did not return a valid view count');
    }

    return json({ path, views: row.views });
  } catch (error) {
    console.error('Failed to update post views', error);
    return json({ error: '阅读次数服务暂不可用' }, 500);
  }
}

export function onRequest() {
  return json({ error: '仅支持 POST 请求' }, 405);
}
