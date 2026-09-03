import session from 'express-session';
import RedisStore from 'connect-redis';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379');
const store = new RedisStore({ client: redis });

const sess = {
  userId: 2,
  isAdmin: false,
  csrfToken: 'abc123'
};

store.set('test-sid-123', sess, async (err) => {
  if (err) { console.error(err); redis.quit(); return; }
  const val = await redis.get('sess:test-sid-123');
  console.log(val);
  redis.quit();
});
