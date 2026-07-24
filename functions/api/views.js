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

function normalizeReferrer(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function truncate(value, maxLength) {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, maxLength);
}

async function hashIp(ip, salt) {
  if (!ip) return null;
  if (typeof salt !== 'string' || !salt) {
    throw new Error('VIEW_IP_SALT is not configured');
  }

  const input = new TextEncoder().encode(`${salt}\0${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
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
    const request = context.request;
    const ipHash = await hashIp(
      request.headers.get('CF-Connecting-IP'),
      context.env.VIEW_IP_SALT
    );
    const referrer = normalizeReferrer(payload?.referrer);
    const userAgent = truncate(request.headers.get('User-Agent'), 512);
    const acceptLanguage = truncate(request.headers.get('Accept-Language'), 128);
    const country = truncate(request.cf?.country, 2);
    const colo = truncate(request.cf?.colo, 3);

    const updateCount = context.env.BLOG_VIEWS_DB.prepare(`
        INSERT INTO post_views (path, views, created_at, updated_at)
        VALUES (?1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET
          views = post_views.views + 1,
          updated_at = CURRENT_TIMESTAMP
        RETURNING views
      `).bind(path);

    const insertEvent = context.env.BLOG_VIEWS_DB.prepare(`
        INSERT INTO post_view_events (
          path,
          ip_hash,
          referrer,
          user_agent,
          accept_language,
          country,
          colo
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `).bind(
        path,
        ipHash,
        referrer,
        userAgent,
        acceptLanguage,
        country,
        colo
      );

    const results = await context.env.BLOG_VIEWS_DB.batch([
      updateCount,
      insertEvent
    ]);
    const row = results[0]?.results?.[0];

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
