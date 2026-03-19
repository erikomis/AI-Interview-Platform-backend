/**
 * Integration tests for RedisService against a real Redis container.
 * Requires Docker running.  Run with: npm run test:integration
 */
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';

// ── Test setup ───────────────────────────────────────────────────────────────

describe('RedisService — Redis integration', () => {
  let container: StartedTestContainer;
  let client: Redis;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .start();

    client = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });
  }, 120_000);

  afterAll(async () => {
    await client.quit();
    await container.stop();
  });

  afterEach(async () => {
    await client.flushdb();
  });

  // ── Core operations ───────────────────────────────────────────────────────

  describe('set / get', () => {
    it('stores a string value and retrieves it', async () => {
      await client.set('key:1', 'hello');
      expect(await client.get('key:1')).toBe('hello');
    });

    it('returns null for a missing key', async () => {
      expect(await client.get('missing-key')).toBeNull();
    });

    it('overwrites an existing key', async () => {
      await client.set('key:ow', 'first');
      await client.set('key:ow', 'second');
      expect(await client.get('key:ow')).toBe('second');
    });

    it('stores and retrieves a serialised JSON object', async () => {
      const payload = { id: 'abc', role: 'engineer', messages: [] };
      await client.set('interview:abc', JSON.stringify(payload));

      const raw = await client.get('interview:abc');
      expect(JSON.parse(raw!)).toMatchObject({ id: 'abc', role: 'engineer' });
    });
  });

  // ── TTL ───────────────────────────────────────────────────────────────────

  describe('set with TTL', () => {
    it('key expires after the configured TTL', async () => {
      await client.set('ephemeral', 'value', 'EX', 1); // 1-second TTL

      expect(await client.get('ephemeral')).toBe('value');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 1200));

      expect(await client.get('ephemeral')).toBeNull();
    });

    it('key without TTL persists', async () => {
      await client.set('persistent', 'value');
      await new Promise((r) => setTimeout(r, 500));
      expect(await client.get('persistent')).toBe('value');
    });
  });

  // ── del ───────────────────────────────────────────────────────────────────

  describe('del', () => {
    it('removes an existing key', async () => {
      await client.set('to-delete', 'gone');
      await client.del('to-delete');
      expect(await client.get('to-delete')).toBeNull();
    });

    it('does not throw when deleting a missing key', async () => {
      await expect(client.del('ghost')).resolves.toBeDefined();
    });
  });

  // ── exists ────────────────────────────────────────────────────────────────

  describe('exists', () => {
    it('returns 1 when key exists', async () => {
      await client.set('present', '1');
      expect(await client.exists('present')).toBe(1);
    });

    it('returns 0 when key does not exist', async () => {
      expect(await client.exists('absent')).toBe(0);
    });
  });

  // ── Interview session simulation ──────────────────────────────────────────

  describe('interview session simulation', () => {
    const INTERVIEW_KEY = 'interview:session-test-001';

    it('simulates a full interview cache lifecycle', async () => {
      const initialState = {
        id: 'session-test-001',
        userId: 'user-123',
        candidateId: 'Alice',
        role: 'Software Engineer',
        status: 'in_progress',
        messages: [{ role: 'interviewer', content: 'Tell me about yourself' }],
      };

      // 1. Save initial state (1-hour TTL)
      await client.set(INTERVIEW_KEY, JSON.stringify(initialState), 'EX', 3600);

      // 2. Load and mutate
      const raw = await client.get(INTERVIEW_KEY);
      const state = JSON.parse(raw!) as typeof initialState;
      state.messages.push({ role: 'candidate', content: 'I am a developer' });

      // 3. Save updated state
      await client.set(INTERVIEW_KEY, JSON.stringify(state), 'EX', 3600);

      // 4. Verify
      const updated = JSON.parse((await client.get(INTERVIEW_KEY))!) as typeof initialState;
      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[1].role).toBe('candidate');

      // 5. TTL should still be active
      const ttl = await client.ttl(INTERVIEW_KEY);
      expect(ttl).toBeGreaterThan(3590);
    });
  });
});
