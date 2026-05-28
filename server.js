/**
 * server.js - Visual reference bookmark backend
 *
 * Local default:
 *   - DB   : sql.js persisted to bookmarks.db
 *   - Auth : nickname/keyfile -> app JWT
 *
 * Production option:
 *   - DB   : Supabase Postgres when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set
 *   - Auth : Google OAuth through Supabase Auth -> HttpOnly app session cookie
 */

'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const http = require('http');
const https = require('https');

let createClient = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch {
  createClient = null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'bookmarks.db');
const DEFAULT_JWT_SECRET = 'bookmark-super-secret-key-change-in-prod';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_EXPIRES = '15d';
const COOKIE_NAME = 'bookmark_session';
const COOKIE_MAX_AGE = 15 * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  '';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLIC_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SUPABASE_ENV_PRESENT = {
  SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
  NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  VITE_SUPABASE_URL: Boolean(process.env.VITE_SUPABASE_URL),
  SUPABASE_ANON_KEY: Boolean(process.env.SUPABASE_ANON_KEY),
  SUPABASE_PUBLIC_ANON_KEY: Boolean(process.env.SUPABASE_PUBLIC_ANON_KEY),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  VITE_SUPABASE_ANON_KEY: Boolean(process.env.VITE_SUPABASE_ANON_KEY),
  SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
};
const SUPABASE_CONFIG_MISSING = [
  !SUPABASE_URL && 'SUPABASE_URL',
  !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
  !SUPABASE_SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY'
].filter(Boolean);

if (SUPABASE_CONFIG_MISSING.length) {
  console.warn('[config] Missing Supabase env:', SUPABASE_CONFIG_MISSING.join(', '));
}

if ((process.env.NODE_ENV === 'production' || process.env.RENDER) && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production.');
}

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    key_hash     TEXT,
    auth_provider TEXT,
    auth_user_id TEXT,
    email        TEXT,
    avatar_url   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    year          INTEGER NOT NULL,
    month         INTEGER NOT NULL,
    day           INTEGER NOT NULL,
    hour          INTEGER NOT NULL,
    minute        INTEGER NOT NULL,
    second        INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`;

let db;
let supabaseAdmin = null;

async function initDb() {
  if (USE_SUPABASE_DB) {
    if (!createClient) {
      throw new Error('@supabase/supabase-js is not installed. Run npm install before deploying.');
    }
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    console.log('[DB] Supabase Postgres enabled');
    return;
  }

  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA);
  ensureSqliteColumns();
  saveDb();
  console.log('[DB] SQLite initialized ->', DB_PATH);
}

function ensureSqliteColumns() {
  const columns = dbAll('PRAGMA table_info(users)').map(row => row.name);
  const additions = [
    ['auth_provider', 'TEXT'],
    ['auth_user_id', 'TEXT'],
    ['email', 'TEXT'],
    ['avatar_url', 'TEXT']
  ];
  additions.forEach(([name, type]) => {
    if (!columns.includes(name)) db.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  });
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

function publicUser(user) {
  return {
    userId: user.id,
    nickname: user.nickname,
    email: user.email || null,
    avatarUrl: user.avatar_url || null
  };
}

function signAppToken(user) {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, index));
      const value = decodeURIComponent(part.slice(index + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER),
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE
  };
}

function setAuthCookie(res, user) {
  res.cookie(COOKIE_NAME, signAppToken(user), cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER),
    sameSite: 'lax',
    path: '/'
  });
}

function getRequestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function isSameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  return origin === getRequestOrigin(req);
}

function isPrivateIp(hostname) {
  if (hostname === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.').map(Number);
    return (
      parts.some(part => part < 0 || part > 255) ||
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) ||
      (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
      (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) ||
      (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
      (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
      parts[0] >= 224
    );
  }
  const ipv6 = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ipv6.startsWith('::ffff:')) return isPrivateIp(ipv6.slice(7));
  return (
    ipv6 === '::1' ||
    ipv6 === '::' ||
    ipv6.startsWith('fc') ||
    ipv6.startsWith('fd') ||
    ipv6.startsWith('fe80:')
  );
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIp(address)) {
      return callback(new Error('내부 네트워크 주소는 가져올 수 없습니다.'));
    }
    return callback(null, address, family);
  });
}

const safeHttpAgent = new http.Agent({ lookup: safeLookup });
const safeHttpsAgent = new https.Agent({ lookup: safeLookup });

function normalizeBookmarkUrl(rawUrl) {
  let url = rawUrl.trim();
  if (url.length > 2048) throw new Error('URL이 너무 깁니다.');
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = `https://${url}`;

  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('http 또는 https URL만 저장할 수 있습니다.');
  }
  if (isPrivateIp(parsed.hostname.toLowerCase())) {
    throw new Error('내부 네트워크 주소는 저장할 수 없습니다.');
  }

  return parsed.toString();
}

function getDisplayName(authUser) {
  const meta = authUser.user_metadata || {};
  return meta.full_name || meta.name || authUser.email?.split('@')[0] || 'Google 사용자';
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------
async function findUserByNickname(nickname) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('nickname', nickname)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return dbGet('SELECT * FROM users WHERE nickname = ?', [nickname]);
}

async function findUserByKeyHash(hash) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('key_hash', hash)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return dbGet('SELECT * FROM users WHERE key_hash = ?', [hash]);
}

async function findUserByAuthId(authUserId) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return dbGet('SELECT * FROM users WHERE auth_user_id = ?', [authUserId]);
}

async function createUser({ nickname, keyHash = null, authProvider = null, authUserId = null, email = null, avatarUrl = null }) {
  const user = {
    id: uuidv4(),
    nickname,
    key_hash: keyHash,
    auth_provider: authProvider,
    auth_user_id: authUserId,
    email,
    avatar_url: avatarUrl,
    created_at: new Date().toISOString()
  };

  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin.from('users').insert(user).select('*').single();
    if (error) throw error;
    return data;
  }

  dbRun(
    `INSERT INTO users
       (id, nickname, key_hash, auth_provider, auth_user_id, email, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id, user.nickname, user.key_hash, user.auth_provider,
      user.auth_user_id, user.email, user.avatar_url, user.created_at
    ]
  );
  return dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
}

async function updateGoogleUser(userId, { nickname, email, avatarUrl }) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ nickname, email, avatar_url: avatarUrl })
      .eq('id', userId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  dbRun(
    'UPDATE users SET nickname = ?, email = ?, avatar_url = ? WHERE id = ?',
    [nickname, email, avatarUrl, userId]
  );
  return dbGet('SELECT * FROM users WHERE id = ?', [userId]);
}

async function getOrCreateGoogleUser(authUser) {
  const meta = authUser.user_metadata || {};
  const nickname = getDisplayName(authUser);
  const email = authUser.email || null;
  const avatarUrl = meta.avatar_url || meta.picture || null;
  let user = await findUserByAuthId(authUser.id);

  if (user) {
    return updateGoogleUser(user.id, { nickname, email, avatarUrl });
  }

  return createUser({
    nickname,
    authProvider: 'google',
    authUserId: authUser.id,
    email,
    avatarUrl
  });
}

async function listBookmarks(userId) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('bookmarks')
      .select('*')
      .eq('user_id', userId)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .order('day', { ascending: false })
      .order('hour', { ascending: false })
      .order('minute', { ascending: false })
      .order('second', { ascending: false });
    if (error) throw error;
    return data;
  }

  return dbAll(
    `SELECT * FROM bookmarks
     WHERE user_id = ?
     ORDER BY year DESC, month DESC, day DESC,
              hour DESC, minute DESC, second DESC`,
    [userId]
  );
}

async function insertBookmark(row) {
  if (USE_SUPABASE_DB) {
    const { error } = await supabaseAdmin.from('bookmarks').insert(row);
    if (error) throw error;
    return;
  }

  dbRun(
    `INSERT INTO bookmarks
       (id, user_id, title, url, thumbnail_url,
        year, month, day, hour, minute, second)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.user_id, row.title, row.url, row.thumbnail_url,
      row.year, row.month, row.day, row.hour, row.minute, row.second
    ]
  );
}

async function findBookmark(id, userId) {
  if (USE_SUPABASE_DB) {
    const { data, error } = await supabaseAdmin
      .from('bookmarks')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  return dbGet('SELECT id FROM bookmarks WHERE id = ? AND user_id = ?', [id, userId]);
}

async function removeBookmark(id, userId) {
  if (USE_SUPABASE_DB) {
    const { error } = await supabaseAdmin
      .from('bookmarks')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw error;
    return;
  }

  dbRun('DELETE FROM bookmarks WHERE id = ? AND user_id = ?', [id, userId]);
}

function mapBookmark(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    thumbnailUrl: row.thumbnail_url,
    date: { year: row.year, month: row.month, day: row.day },
    time: { hour: row.hour, minute: row.minute, second: row.second }
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isSameOrigin(req)) return next();
  return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' });
});
app.use(express.json({ limit: '1mb' }));
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use(express.static(PUBLIC_DIR));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.redirect(301, '/login');
});

app.get('/index.html', (req, res) => {
  res.redirect(301, '/app');
});

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '만료되거나 유효하지 않은 토큰입니다.' });
  }
}

app.get('/api/config', (req, res) => {
  res.json({
    supabaseEnabled: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
    supabaseServerEnabled: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    supabaseMissing: SUPABASE_CONFIG_MISSING,
    supabaseEnvPresent: SUPABASE_ENV_PRESENT,
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null
  });
});

app.post('/api/auth/supabase', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !createClient) {
    return res.status(503).json({ error: 'Supabase 로그인이 설정되지 않았습니다.' });
  }

  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Supabase access token이 없습니다.' });

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data?.user) {
      if (error) console.error('[supabase token invalid]', error.message || error);
      return res.status(401).json({ error: 'Supabase 토큰이 유효하지 않습니다.' });
    }

    const user = await getOrCreateGoogleUser(data.user);
    setAuthCookie(res, user);
    return res.json(publicUser(user));
  } catch (err) {
    console.error('[supabase auth failed]', err);
    return res.status(500).json({ error: 'Google 로그인 처리 중 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { type, nickname, keyContent } = req.body;

  try {
    if (type === 'nickname') {
      if (!nickname || nickname.trim().length < 2) {
        return res.status(400).json({ error: '닉네임은 2글자 이상이어야 합니다.' });
      }

      const name = nickname.trim();
      let user = await findUserByNickname(name);
      if (!user) user = await createUser({ nickname: name });

      setAuthCookie(res, user);
      return res.json(publicUser(user));
    }

    if (type === 'keyfile') {
      if (!keyContent) return res.status(400).json({ error: '키 파일 내용이 없습니다.' });

      const hash = simpleHash(keyContent.trim());
      let user = await findUserByKeyHash(hash);
      if (!user) {
        user = await createUser({
          nickname: `사용자_${uuidv4().slice(0, 6)}`,
          keyHash: hash
        });
      }

      setAuthCookie(res, user);
      return res.json(publicUser(user));
    }

    return res.status(400).json({ error: '지원하지 않는 로그인 방식입니다.' });
  } catch (err) {
    console.error('[login failed]', err);
    return res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/verify', (req, res) => {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return res.status(401).json({ valid: false, error: '로그인이 필요합니다.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({
      valid: true,
      nickname: payload.nickname,
      email: payload.email || null,
      avatarUrl: payload.avatarUrl || null
    });
  } catch {
    return res.status(401).json({ valid: false, error: '유효하지 않은 토큰입니다.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get('/api/bookmarks', requireAuth, async (req, res) => {
  try {
    const rows = await listBookmarks(req.user.userId);
    res.json(rows.map(mapBookmark));
  } catch (err) {
    console.error('[bookmarks list failed]', err);
    res.status(500).json({ error: '북마크를 불러오지 못했습니다.' });
  }
});

app.post('/api/bookmarks', requireAuth, async (req, res) => {
  let { url, customName } = req.body;
  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' });

  try {
    url = normalizeBookmarkUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let finalTitle = customName?.trim() || '';
  let finalImg = 'https://via.placeholder.com/300x180?text=No+Image';
  const isYoutube = url.includes('youtube.com') || url.includes('youtu.be');

  if (isYoutube) {
    let videoId = '';
    if (url.includes('watch?v=')) videoId = url.split('v=')[1]?.split('&')[0];
    else if (url.includes('youtu.be/')) videoId = url.split('youtu.be/')[1]?.split('?')[0];
    else videoId = url.split('/').pop()?.split('?')[0];
    if (videoId) finalImg = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  }

  try {
    if (!finalTitle && isYoutube) {
      const ytRes = await axios.get(
        `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
        {
          timeout: 5000,
          httpAgent: safeHttpAgent,
          httpsAgent: safeHttpsAgent,
          maxRedirects: 3
        }
      );
      if (ytRes.data?.title) finalTitle = ytRes.data.title;
    } else if (!finalTitle) {
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000,
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
        maxRedirects: 3
      });
      const $ = cheerio.load(response.data);

      finalTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
      const ogImg = $('meta[property="og:image"]').attr('content');
      if (ogImg) {
        finalImg = ogImg;
      } else {
        let iconHref = $('link[rel="icon"]').attr('href')
          || $('link[rel="shortcut icon"]').attr('href');
        if (iconHref && !iconHref.startsWith('http')) {
          const origin = new URL(url).origin;
          iconHref = origin + (iconHref.startsWith('/') ? '' : '/') + iconHref;
        }
        if (iconHref) finalImg = iconHref;
      }
    }
  } catch (err) {
    console.error(`[crawl failed] ${url}:`, err.message);
  }

  if (!finalTitle) finalTitle = '새로운 북마크';

  const now = new Date();
  const row = {
    id: uuidv4(),
    user_id: req.user.userId,
    title: finalTitle.trim(),
    url,
    thumbnail_url: finalImg,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds()
  };

  try {
    await insertBookmark(row);
    res.json(mapBookmark(row));
  } catch (err) {
    console.error('[bookmark insert failed]', err);
    res.status(500).json({ error: '북마크를 저장하지 못했습니다.' });
  }
});

app.delete('/api/bookmarks/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await findBookmark(id, req.user.userId);
    if (!existing) return res.status(404).json({ error: '북마크를 찾을 수 없습니다.' });

    await removeBookmark(id, req.user.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('[bookmark delete failed]', err);
    res.status(500).json({ error: '북마크를 삭제하지 못했습니다.' });
  }
});

app.get('/', (req, res) => {
  res.redirect('/login');
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\nServer: http://localhost:${PORT}`);
    console.log(`Login : http://localhost:${PORT}/login`);
    console.log(`App   : http://localhost:${PORT}/app`);
    console.log(`DB    : ${USE_SUPABASE_DB ? 'Supabase' : 'SQLite'}\n`);
  });
}).catch(err => {
  console.error('[fatal] DB init failed:', err);
  process.exit(1);
});
