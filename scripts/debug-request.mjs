import crypto from 'node:crypto';
import http from 'node:http';
import Redis from 'ioredis';

const SESSION_SECRET = 'elective-system-load-test-secret-2026-09-03';
const sid = crypto.randomUUID();
const csrf = crypto.randomBytes(32).toString('hex');
const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function sign(val, secret) {
  return val + '.' + crypto.createHmac('sha256', secret).update(val).digest('base64').replace(/=+$/, '');
}

const redis = new Redis('redis://localhost:6379');
await redis.set(`sess:${sid}`, JSON.stringify({
  userId: 2,
  isAdmin: false,
  csrfToken: csrf,
  cookie: { originalMaxAge: 7 * 24 * 60 * 60 * 1000, expires, httpOnly: true, sameSite: 'lax', secure: false, path: '/' }
}));

const cookie = `connect.sid=s%3A${encodeURIComponent(sign(sid, SESSION_SECRET))}`;
console.log('Cookie:', cookie);
console.log('CSRF:', csrf);

const req = http.request('http://localhost:8080/api/courses/1/select', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie, 'X-CSRF-Token': csrf }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);
    console.log('Body:', body.slice(0, 500));
    redis.quit();
  });
});
req.on('error', (err) => { console.error('Req error:', err.message); redis.quit(); });
req.write('_csrf=' + encodeURIComponent(csrf));
req.end();
