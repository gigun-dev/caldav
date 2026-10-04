// 本番のDAVに障害注入経路を置かず、合成エラーだけでIssuesの検知を確認する。
export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/exception') throw new Error('caldav verification synthetic exception');
    if (path === '/status-503') return new Response('synthetic unavailable', { status: 503 });
    if (path === '/handled-error') {
      console.error('caldav verification synthetic handled error');
      return new Response('synthetic handled error', { status: 200 });
    }
    return new Response('verification fixture', { status: path === '/health' ? 200 : 404 });
  },
};
