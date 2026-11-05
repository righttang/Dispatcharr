const target = 'http://192.168.50.84:9191';
const proxy = Object.fromEntries(['/api', '/proxy', '/output', '/static', '/ws'].map((path) => [
  path, { target, changeOrigin: true, ws: path === '/ws' },
]));

export default {
  root: new URL('./upstream/dispatcharr-mobile/frontend', import.meta.url).pathname,
  preview: { host: '127.0.0.1', port: 19091, strictPort: true, proxy },
};
