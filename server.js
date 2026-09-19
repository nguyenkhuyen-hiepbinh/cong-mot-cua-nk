'use strict';

/**
 * Cổng Một Cửa Số — Trường THCS – THPT Nguyễn Khuyến
 * Backend tối giản: Node thuần, không dependency.
 *
 * Nguồn dữ liệu chính là dulieu.json trong repository GitHub.
 * Khi quản trị viên bấm Lưu, server ghi thẳng lên GitHub qua Contents API.
 *
 * Biến môi trường:
 *   ADMIN_PIN       (bắt buộc) mã đăng nhập quản trị
 *   GITHUB_TOKEN    (bắt buộc khi chạy thật) fine-grained token, quyền Contents: Read and write
 *   GITHUB_REPO     mặc định nguyenkhuyen-hiepbinh/cong-mot-cua-nk
 *   GITHUB_FILE     mặc định dulieu.json
 *   GITHUB_BRANCH   mặc định main
 *   SESSION_SECRET  tuỳ chọn; bỏ trống thì sinh ngẫu nhiên mỗi lần khởi động
 *
 * Không có GITHUB_TOKEN, server chạy ở chế độ tệp cục bộ (đọc/ghi ./dulieu.json)
 * để phát triển và kiểm thử.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'nguyenkhuyen-hiepbinh/cong-mot-cua-nk';
const GITHUB_FILE = process.env.GITHUB_FILE || 'dulieu.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const USE_GITHUB = Boolean(GITHUB_TOKEN);
const LOCAL_DATA = path.join(__dirname, GITHUB_FILE);
const COOKIE_NAME = 'nk_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const CACHE_MS = 30 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_BODY = 512 * 1024;

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/dulieu.json': { file: 'dulieu.json', type: 'application/json; charset=utf-8' }
};

/* ------------------------------------------------------------------ *
 * Schema v2 + migration
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  schoolName: 'Trường THCS – THPT Nguyễn Khuyến',
  portalName: 'Cổng Một Cửa Số'
};

const STATUSES = ['active', 'maintenance', 'unavailable', 'unknown'];
const TONES = ['teal', 'blue', 'violet', 'amber', 'slate', 'seal'];

function str(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max || 500);
}

function pickTone(value) {
  return TONES.includes(value) ? value : 'slate';
}

function pickStatus(value) {
  return STATUSES.includes(value) ? value : 'unknown';
}

function slugId(name, taken) {
  const base = str(name, 60)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 14) || 'muc';
  let id = base;
  let i = 2;
  while (taken.includes(id)) { id = base + i; i += 1; }
  return id;
}

/** Nhận dữ liệu v1 (mảng, hoặc {groups, accts, systems}) lẫn v2, trả về v2 sạch. */
function migrate(raw) {
  let groups = [];
  let accounts = [];
  let systems = [];
  let settings = { ...DEFAULT_SETTINGS };

  if (Array.isArray(raw)) {
    systems = raw;
  } else if (raw && typeof raw === 'object') {
    groups = Array.isArray(raw.groups) ? raw.groups : [];
    accounts = Array.isArray(raw.accounts) ? raw.accounts
      : Array.isArray(raw.accts) ? raw.accts : [];
    systems = Array.isArray(raw.systems) ? raw.systems : [];
    if (raw.settings && typeof raw.settings === 'object') {
      settings = {
        schoolName: str(raw.settings.schoolName, 160) || DEFAULT_SETTINGS.schoolName,
        portalName: str(raw.settings.portalName, 160) || DEFAULT_SETTINGS.portalName
      };
    }
  }

  const groupIds = [];
  const cleanGroups = groups.slice(0, 40).map((g) => {
    const id = str(g && g.id, 40) || slugId(g && g.name, groupIds);
    groupIds.push(id);
    return { id, name: str(g && g.name, 120) || id, tone: pickTone(g && g.tone) };
  });

  const accountIds = [];
  const cleanAccounts = accounts.slice(0, 40).map((a) => {
    const id = str(a && a.id, 40) || slugId((a && (a.label || a.name)), accountIds);
    accountIds.push(id);
    return {
      id,
      label: str(a && (a.label || a.name), 120) || id,
      tone: pickTone(a && a.tone),
      hint: str(a && a.hint, 400)
    };
  });

  const fallbackGroup = cleanGroups.length ? cleanGroups[0].id : '';
  const fallbackAccount = cleanAccounts.length ? cleanAccounts[0].id : '';
  const systemIds = [];

  const cleanSystems = systems.slice(0, 500).map((s) => {
    const src = s && typeof s === 'object' ? s : {};
    const login = src.login && typeof src.login === 'object' ? src.login : {};
    const contact = src.contact && typeof src.contact === 'object' ? src.contact : {};
    const id = str(src.id, 40) || slugId(src.name, systemIds);
    systemIds.push(id);

    const group = str(src.group, 40);
    const accountType = str(src.accountType || src.acct, 40);

    return {
      id,
      name: str(src.name, 160) || 'Chưa đặt tên',
      url: str(src.url, 600),
      group: cleanGroups.some((g) => g.id === group) ? group : fallbackGroup,
      accountType: cleanAccounts.some((a) => a.id === accountType) ? accountType : fallbackAccount,
      status: pickStatus(src.status || 'active'),
      description: str(src.description || src.desc, 500),
      login: {
        username: str(login.username || src.user, 300),
        issuer: str(login.issuer || src.issuer, 300),
        reset: str(login.reset || src.reset, 400)
      },
      contact: { owner: str(contact.owner || src.owner, 200) },
      notes: str(src.notes, 1200)
    };
  });

  return { version: 2, settings, groups: cleanGroups, accounts: cleanAccounts, systems: cleanSystems };
}

/** Kiểm tra dữ liệu quản trị gửi lên trước khi ghi. */
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'Dữ liệu gửi lên không đúng định dạng.' };
  }
  if (!Array.isArray(payload.systems)) {
    return { ok: false, message: 'Thiếu danh sách hệ thống.' };
  }
  if (!Array.isArray(payload.groups) || payload.groups.length === 0) {
    return { ok: false, message: 'Phải có ít nhất một nhóm công việc.' };
  }
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : payload.accts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, message: 'Phải có ít nhất một loại tài khoản.' };
  }
  if (payload.systems.length > 500) {
    return { ok: false, message: 'Vượt quá 500 hệ thống.' };
  }
  const data = migrate(payload);
  const ids = data.systems.map((s) => s.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: 'Có hệ thống trùng mã định danh.' };
  }
  return { ok: true, data };
}

/* ------------------------------------------------------------------ *
 * Lưu trữ: GitHub Contents API, hoặc tệp cục bộ khi phát triển
 * ------------------------------------------------------------------ */

let cache = { data: null, sha: null, at: 0 };

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cong-mot-cua-nk'
  };
}

async function readStore(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    return { data: cache.data, sha: cache.sha };
  }

  if (!USE_GITHUB) {
    const text = await fsp.readFile(LOCAL_DATA, 'utf8');
    const data = migrate(JSON.parse(text));
    cache = { data, sha: null, at: Date.now() };
    return { data, sha: null };
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub đọc dữ liệu thất bại (HTTP ${res.status})`);
  }
  const json = await res.json();
  const text = Buffer.from(json.content || '', 'base64').toString('utf8');
  const data = migrate(JSON.parse(text));
  cache = { data, sha: json.sha, at: Date.now() };
  return { data, sha: json.sha };
}

async function writeStore(data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;

  if (!USE_GITHUB) {
    await fsp.writeFile(LOCAL_DATA, text, 'utf8');
    cache = { data, sha: null, at: Date.now() };
    return;
  }

  // Luôn lấy sha mới nhất để phát hiện người khác vừa sửa.
  const current = await readStore(true);
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_FILE)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Cập nhật danh mục hệ thống từ Cổng Một Cửa',
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha: current.sha,
      branch: GITHUB_BRANCH
    })
  });

  if (res.status === 409 || res.status === 422) {
    throw Object.assign(new Error('Dữ liệu đã có người khác cập nhật. Hãy tải lại trang rồi sửa lại.'), { status: 409 });
  }
  if (!res.ok) {
    throw new Error(`GitHub ghi dữ liệu thất bại (HTTP ${res.status})`);
  }
  const json = await res.json();
  cache = { data, sha: json.content && json.content.sha, at: Date.now() };
}

/* ------------------------------------------------------------------ *
 * Phiên đăng nhập
 * ------------------------------------------------------------------ */

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function isSecure(req) {
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function cookieHeader(req, value, maxAgeSeconds) {
  const bits = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (isSecure(req)) bits.push('Secure');
  return bits.join('; ');
}

function isAdmin(req) {
  return verifyToken(readCookie(req, COOKIE_NAME));
}

const loginAttempts = new Map(); // ip -> { fails, until }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function loginLockedFor(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || !entry.until) return 0;
  const left = entry.until - Date.now();
  if (left <= 0) { loginAttempts.delete(ip); return 0; }
  return left;
}

function noteLoginFail(ip) {
  const entry = loginAttempts.get(ip) || { fails: 0, until: 0 };
  entry.fails += 1;
  if (entry.fails >= LOGIN_MAX_FAILS) {
    entry.until = Date.now() + LOGIN_LOCK_MS;
    entry.fails = 0;
  }
  loginAttempts.set(ip, entry);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // không phải request từ trình duyệt khác site
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Dữ liệu quá lớn.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON không hợp lệ.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy trang.');
    return;
  }
  const file = path.join(__dirname, entry.file);
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Không tìm thấy tệp.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': entry.file === 'index.html' ? 'no-cache' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* giữ mặc định */ }

  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, storage: USE_GITHUB ? 'github' : 'local' });
      return;
    }

    if (pathname === '/api/session') {
      sendJson(res, 200, { admin: isAdmin(req), configured: Boolean(ADMIN_PIN), storage: USE_GITHUB ? 'github' : 'local' });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'Yêu cầu không hợp lệ.' }); return; }
      const ip = clientIp(req);
      const lock = loginLockedFor(ip);
      if (lock > 0) {
        sendJson(res, 429, { error: `Đã nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(lock / 60000)} phút.` });
        return;
      }
      if (!ADMIN_PIN) { sendJson(res, 503, { error: 'Máy chủ chưa cấu hình mã quản trị.' }); return; }

      const body = await readBody(req);
      const pin = String(body.pin || '');
      const a = Buffer.from(crypto.createHash('sha256').update(pin).digest());
      const b = Buffer.from(crypto.createHash('sha256').update(ADMIN_PIN).digest());
      if (!crypto.timingSafeEqual(a, b)) {
        noteLoginFail(ip);
        sendJson(res, 401, { error: 'Mã quản trị chưa đúng.' });
        return;
      }
      loginAttempts.delete(ip);
      res.setHeader('Set-Cookie', cookieHeader(req, makeToken(), SESSION_MS / 1000));
      sendJson(res, 200, { admin: true });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
      sendJson(res, 200, { admin: false });
      return;
    }

    if (pathname === '/api/data' && req.method === 'GET') {
      try {
        const { data } = await readStore(false);
        sendJson(res, 200, data);
      } catch (err) {
        console.error('[doc du lieu]', err && err.message);
        sendJson(res, 502, { error: 'Không đọc được danh mục từ máy chủ dữ liệu. Hãy tải lại trang sau ít phút.' });
      }
      return;
    }

    if (pathname === '/api/data' && req.method === 'POST') {
      if (!isAdmin(req)) { sendJson(res, 401, { error: 'Phiên quản trị đã hết hạn. Hãy đăng nhập lại.' }); return; }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'Yêu cầu không hợp lệ.' }); return; }

      const body = await readBody(req);
      const check = validate(body);
      if (!check.ok) { sendJson(res, 400, { error: check.message }); return; }

      await writeStore(check.data);
      sendJson(res, 200, check.data);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Không có API này.' });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    const message = status === 500
      ? 'Không thể lưu dữ liệu lên máy chủ. Dữ liệu chưa được thay đổi trên hệ thống.'
      : err.message;
    console.error('[loi]', err && err.message);
    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Cổng Một Cửa Số đang chạy ở cổng ${PORT} — lưu trữ: ${USE_GITHUB ? 'GitHub ' + GITHUB_REPO : 'tệp cục bộ'}`);
  if (!ADMIN_PIN) console.warn('Cảnh báo: chưa đặt ADMIN_PIN, chức năng quản trị bị khoá.');
});
