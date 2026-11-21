import { createServer } from 'node:http';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from './lib/database.mjs';
import { types, defaults, InputError, string, validateConfig, makePlan } from './lib/protocol.mjs';
import { score, describe, csv, timingCsv } from './lib/results.mjs';

import { escape as escapeHtml } from './public/ui.js';

const dataDir = resolve(process.env.DATA_DIR || 'data');
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const setupToken = process.env.SETUP_TOKEN;
const secureCookies = process.env.SECURE_COOKIES === '1';
const sessionLifetime = 8 * 60 * 60 * 1000;
const attemptLifetime = 4 * 60 * 60 * 1000;
const invitationPageSize = 8;
const deriveKey = promisify(scrypt);
const token = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
process.umask(0o077);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dataDir, 'study.sqlite'));
initializeDatabase(db);

const run = (sql, ...params) => db.prepare(sql).run(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const nowISO = () => new Date().toISOString();

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

transaction(() => {
  if (get('SELECT id FROM tests LIMIT 1')) return;
  for (const type of ['gonogo', 'stop']) {
    const config = JSON.stringify(defaults[type]);
    const test = run('INSERT INTO tests (type, config) VALUES (?, ?)', type, config);
    run("INSERT INTO invitations (code,test_id,config,label,created_at) VALUES (?,?,?,'Website',?)",
      token(), test.lastInsertRowid, config, nowISO());
  }
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const notFound = () => new HttpError(404, 'Página ou recurso indisponível.');
const missingInvite = () => new HttpError(404, 'Este convite é inválido ou foi desativado.');

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new HttpError(415, 'Use o formato JSON.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256 * 1024) throw new HttpError(413, 'O pedido é demasiado grande.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new InputError('O pedido contém JSON inválido.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('O pedido é inválido.');
  return body;
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function cookie(response, value, maxAge) {
  response.setHeader('Set-Cookie',
    `study_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`);
}

function session(request) {
  const value = /(?:^|;\s*)study_session=([\w-]{32})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
  return value ? get('SELECT id FROM sessions WHERE id = ? AND expires > ?', hash(value), Date.now()) : null;
}

const rateLimits = new Map();
function limit(request, group, max, interval) {
  const now = Date.now();
  if (rateLimits.size > 1000) {
    for (const [key, entry] of rateLimits) if (entry.until <= now) rateLimits.delete(key);
    if (rateLimits.size > 3000) throw new HttpError(429, 'Tente novamente dentro de alguns minutos.');
  }
  const key = `${group}:${request.socket.remoteAddress}`;
  let entry = rateLimits.get(key);
  if (!entry || entry.until <= now) {
    entry = { until: now + interval, attempts: 0 };
    rateLimits.set(key, entry);
  }
  if (++entry.attempts > max) throw new HttpError(429, 'Demasiados pedidos. Tente novamente dentro de alguns minutos.');
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    throw new InputError('Introduza uma palavra-passe com até 256 caracteres.');
  }
}

async function matchesPassword(password, admin) {
  const derived = await deriveKey(password, admin.salt, 64);
  return timingSafeEqual(derived, Buffer.from(admin.password_hash, 'hex'));
}

function newSession() {
  const value = token();
  run('INSERT INTO sessions VALUES (?, ?)', hash(value), Date.now() + sessionLifetime);
  return value;
}

function respondWithSession(response, value) {
  cookie(response, value, sessionLifetime / 1000);
  json(response, { authenticated: true });
}

async function auth(request, response, setup) {
  limit(request, 'auth', 15, 15 * 60 * 1000);
  const body = await readJson(request);
  const password = body.password;
  validatePassword(password);
  const admin = get('SELECT salt, password_hash FROM admin WHERE id = 1');
  let value;
  if (setup) {
    if (admin) throw new HttpError(409, 'A palavra-passe já foi configurada.');
    if (setupToken && (typeof body.setupToken !== 'string' ||
        !timingSafeEqual(Buffer.from(hash(body.setupToken)), Buffer.from(hash(setupToken))))) {
      throw new HttpError(403, 'O código de configuração é inválido.');
    }
    const salt = randomBytes(16).toString('hex');
    const derived = await deriveKey(password, salt, 64);
    value = transaction(() => {
      if (!run('INSERT OR IGNORE INTO admin VALUES (1, ?, ?)', salt, derived.toString('hex')).changes) {
        throw new HttpError(409, 'A palavra-passe já foi configurada.');
      }
      return newSession();
    });
  } else {
    if (!admin) throw new HttpError(409, 'Configure primeiro a palavra-passe.');
    if (!await matchesPassword(password, admin)) throw new HttpError(401, 'Palavra-passe incorreta.');
    value = transaction(() => {
      if (!get('SELECT id FROM admin WHERE id = 1 AND salt = ?', admin.salt)) {
        throw new HttpError(401, 'Palavra-passe incorreta.');
      }
      run('DELETE FROM sessions WHERE expires <= ?', Date.now());
      return newSession();
    });
  }
  respondWithSession(response, value);
}

async function changePassword(request, response, currentSession) {
  limit(request, 'password', 15, 15 * 60 * 1000);
  const { currentPassword, newPassword } = await readJson(request);
  validatePassword(currentPassword);
  validatePassword(newPassword);
  const admin = get('SELECT salt, password_hash FROM admin WHERE id = 1');
  if (!admin || !await matchesPassword(currentPassword, admin)) {
    throw new HttpError(403, 'A palavra-passe atual está incorreta.');
  }

  const salt = randomBytes(16).toString('hex');
  const derived = await deriveKey(newPassword, salt, 64);
  const value = transaction(() => {
    if (!get('SELECT id FROM sessions WHERE id = ? AND expires > ?', currentSession.id, Date.now())) {
      throw new HttpError(401, 'Inicie sessão para continuar.');
    }
    if (!run('UPDATE admin SET salt = ?, password_hash = ? WHERE id = 1 AND salt = ?',
      salt, derived.toString('hex'), admin.salt).changes) {
      throw new HttpError(409, 'A palavra-passe foi alterada. Tente novamente.');
    }
    run('DELETE FROM sessions');
    return newSession();
  });
  respondWithSession(response, value);
}

function testRecord(id) {
  const row = get('SELECT id, type, config FROM tests WHERE id = ? AND deleted_at IS NULL', id);
  if (!row) throw notFound();
  return row;
}

function adminTest(row) {
  return { ...row, config: JSON.parse(row.config), editToken: hash(row.config) };
}

function saveTest(type, inputs, id, editToken) {
  const config = JSON.stringify(validateConfig(type, inputs));
  return transaction(() => {
    if (id) {
      const current = testRecord(id);
      if (current.type !== type) throw new InputError('O tipo de um teste existente é fixo.');
      if (editToken !== hash(current.config)) throw new HttpError(409, 'O teste foi alterado. Volte a abrir o editor.');
      run('UPDATE tests SET config = ? WHERE id = ?', config, id);
    } else {
      id = Number(run('INSERT INTO tests (type, config) VALUES (?, ?)', type, config).lastInsertRowid);
    }
    return adminTest({ id, type, config });
  });
}

const usageCount = '(SELECT count(*) FROM submissions s WHERE s.code = i.code)';

function invitation(code) {
  if (typeof code !== 'string' || !/^[\w-]{32}$/.test(code)) throw missingInvite();
  const row = get(`SELECT i.*, t.type FROM invitations i
    JOIN tests t ON t.id = i.test_id AND t.deleted_at IS NULL
    WHERE i.code = ?`, code);
  if (!row || row.revoked) throw missingInvite();
  return row;
}

function submissions(id) {
  return all(`SELECT s.id, s.completed_at AS completedAt, s.results, i.config
    FROM submissions s JOIN invitations i ON i.code = s.code
    WHERE i.test_id = ? ORDER BY s.completed_at DESC`, id)
    .map(row => ({ ...row, results: JSON.parse(row.results), config: JSON.parse(row.config) }));
}

function invitationCounts(id) {
  return get(`SELECT count(*) AS totalInvites, coalesce(sum(${usageCount}), 0) AS completed,
    count(*) FILTER (WHERE i.revoked = 0) AS availableInvites
    FROM invitations i WHERE i.test_id = ?`, id);
}

function invitationPage(id, requested) {
  if (requested !== null && (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested)))) {
    throw new InputError('Indique um número de página válido.');
  }
  const counts = invitationCounts(id);
  const totalPages = Math.ceil(counts.totalInvites / invitationPageSize);
  const page = Math.min(requested === null ? 1 : Number(requested), Math.max(1, totalPages));
  const invites = all(`SELECT i.code, i.label, i.created_at AS createdAt, i.revoked, ${usageCount} AS completed
    FROM invitations i
    WHERE i.test_id = ? ORDER BY i.created_at DESC, i.rowid DESC LIMIT ? OFFSET ?`,
    id, invitationPageSize, (page - 1) * invitationPageSize);
  return { invites, page, pageSize: invitationPageSize, totalPages, ...counts };
}

function startAttempt(code) {
  const invite = invitation(code);
  run('DELETE FROM attempts WHERE expires <= ?', Date.now());
  const plan = makePlan(invite.type, JSON.parse(invite.config));
  const attempt = token();
  run('INSERT INTO attempts VALUES (?, ?, ?, ?)', hash(attempt), code, JSON.stringify(plan), Date.now() + attemptLifetime);
  return { attempt, plan };
}

function submit(body) {
  if (typeof body.attempt !== 'string' || !/^[\w-]{32}$/.test(body.attempt)) {
    throw new HttpError(410, 'A sessão expirou. Abra novamente o convite.');
  }
  const id = hash(body.attempt);
  return transaction(() => {
    const existing = get('SELECT id FROM submissions WHERE attempt_id = ?', id);
    if (existing) return { participantId: existing.id };
    const attempt = get('SELECT * FROM attempts WHERE id = ? AND expires > ?', id, Date.now());
    if (!attempt) throw new HttpError(410, 'A sessão expirou. Abra novamente o convite.');
    const invite = invitation(attempt.code);
    const name = string(body.name, 120, 'o nome', true);
    const email = string(body.email, 254, 'o endereço de email', true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError('Introduza um endereço de email válido.');
    const results = score(invite.type, JSON.parse(invite.config), JSON.parse(attempt.plan), body.responses);
    const participantId = randomBytes(12).toString('hex');
    run('INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?)',
      participantId, id, attempt.code, name, email, nowISO(), JSON.stringify(results));
    run('DELETE FROM attempts WHERE id = ?', id);
    return { participantId };
  });
}

async function api(request, response, url) {
  const { pathname, searchParams } = url;
  const method = request.method;
  if (pathname === '/api/health' && method === 'GET') return json(response, { status: 'ok' });
  if (pathname === '/api/test' && method === 'GET') {
    const invite = invitation(searchParams.get('code'));
    return json(response, { id: invite.test_id, type: invite.type, config: JSON.parse(invite.config) });
  }
  if (pathname === '/api/test/start' && method === 'POST') {
    limit(request, 'start', 120, 60 * 1000);
    return json(response, startAttempt((await readJson(request)).code), 201);
  }
  if (pathname === '/api/test/submit' && method === 'POST') return json(response, submit(await readJson(request)));
  if (!pathname.startsWith('/api/admin/')) throw notFound();

  const currentSession = session(request);
  if (pathname === '/api/admin/session' && method === 'GET') {
    return json(response, {
      authenticated: Boolean(currentSession), setup: !get('SELECT id FROM admin WHERE id = 1'),
      setupTokenRequired: Boolean(setupToken),
    });
  }
  if (pathname === '/api/admin/setup' && method === 'POST') return auth(request, response, true);
  if (pathname === '/api/admin/login' && method === 'POST') return auth(request, response, false);
  if (!currentSession) throw new HttpError(401, 'Inicie sessão para continuar.');
  if (pathname === '/api/admin/password' && method === 'POST') return changePassword(request, response, currentSession);
  if (pathname === '/api/admin/logout' && method === 'POST') {
    await readJson(request);
    run('DELETE FROM sessions WHERE id = ?', currentSession.id);
    cookie(response, '', 0);
    return json(response, { authenticated: false });
  }
  if (pathname === '/api/admin/tests' && method === 'GET') {
    const tests = all('SELECT id, type, config FROM tests WHERE deleted_at IS NULL ORDER BY id').map(adminTest);
    return json(response, { tests, defaults, types });
  }
  if (pathname === '/api/admin/tests' && method === 'POST') {
    const body = await readJson(request);
    return json(response, saveTest(body.type, body.config), 201);
  }

  const testRoute = /^\/api\/admin\/tests\/(\d+)(?:\/(results|csv|timing-csv|invitations|participants))?$/.exec(pathname);
  if (testRoute) {
    const id = Number(testRoute[1]);
    if (!Number.isSafeInteger(id)) throw notFound();
    const section = testRoute[2];
    if (!section && method === 'GET') {
      return json(response, { test: adminTest(testRecord(id)), counts: invitationCounts(id) });
    }
    if (!section && method === 'PUT') {
      const body = await readJson(request);
      return json(response, saveTest(body.type, body.config, id, body.editToken));
    }
    if (!section && method === 'DELETE') {
      const result = run('UPDATE tests SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', nowISO(), id);
      if (!result.changes) throw notFound();
      return json(response, { deleted: true });
    }
    if (section === 'invitations' && method === 'POST') {
      const body = await readJson(request);
      const label = string(body.label, 100, 'a referência do convite', true);
      const code = token();
      const createdAt = nowISO();
      transaction(() => {
        const test = testRecord(id);
        run('INSERT INTO invitations (code, test_id, config, label, created_at) VALUES (?, ?, ?, ?, ?)',
          code, id, test.config, label, createdAt);
      });
      return json(response, { code, label, createdAt, revoked: 0, completed: 0 }, 201);
    }
    if (section === 'invitations' && method === 'GET') {
      testRecord(id);
      return json(response, invitationPage(id, searchParams.get('page')));
    }
    if (section === 'participants' && method === 'GET') {
      testRecord(id);
      const personId = searchParams.get('id');
      if (personId !== null) {
        const person = get(`SELECT s.id, s.name, s.email, s.completed_at AS completedAt, i.label,
          i.config, s.results FROM submissions s JOIN invitations i ON i.code = s.code
          WHERE i.test_id = ? AND s.id = ?`, id, personId);
        if (!person) throw notFound();
        return json(response, { ...person, config: JSON.parse(person.config), results: JSON.parse(person.results) });
      }
      const participants = all(`SELECT s.id, s.name, s.email, s.completed_at AS completedAt, i.label
        FROM submissions s JOIN invitations i ON i.code = s.code
        WHERE i.test_id = ? ORDER BY s.completed_at DESC, s.rowid DESC`, id);
      return json(response, { participants, counts: invitationCounts(id) });
    }
    if (method === 'GET' && ['results', 'csv', 'timing-csv'].includes(section)) {
      const test = adminTest(testRecord(id));
      const records = submissions(id);
      if (section !== 'results') {
        const timing = section === 'timing-csv';
        if (timing && test.type === 'survey') throw notFound();
        const data = timing ? timingCsv(describe(test.type, test.config, records))
          : csv(test.type, test.config, records);
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="estudo-${id}${timing ? '-tempos' : ''}.csv"` });
        return response.end(data);
      }
      const mixedConfigs = new Set(records.map(record => JSON.stringify(validateConfig(test.type, record.config)))).size > 1;
      return json(response, { completed: records.length, counts: invitationCounts(id), mixedConfigs, stats: describe(test.type, test.config, records) });
    }
  }

  const revoke = /^\/api\/admin\/invitations\/([\w-]{32})\/revoke$/.exec(pathname);
  if (revoke && method === 'POST') {
    await readJson(request);
    const invite = invitation(revoke[1]);
    run('UPDATE invitations SET revoked = 1 WHERE code = ?', invite.code);
    return json(response, { revoked: true });
  }
  throw notFound();
}

const pages = { '/': 'index.html', '/admin': 'admin.html', '/test': 'test.html' };
const media = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(request.url, 'http://study.local');
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Método indisponível.');
    const filename = Object.hasOwn(pages, url.pathname) ? pages[url.pathname] :
      /^\/(?:style\.css|(?:admin|participant|ui|engine)\.js)$/.test(url.pathname) ? url.pathname.slice(1) : null;
    if (!filename) throw notFound();
    response.writeHead(200, { 'Content-Type': media[extname(filename)] });
    if (filename === 'index.html' && request.method === 'GET') {
      const links = all(`SELECT i.code, json_extract(i.config, '$.title') AS title
        FROM invitations i JOIN tests t ON t.id = i.test_id
        WHERE i.label = 'Website' AND t.deleted_at IS NULL AND i.revoked = 0
        ORDER BY title, i.created_at, i.code`);
      const items = links.map(link => `<a href="/test?code=${encodeURIComponent(link.code)}">${escapeHtml(link.title)}</a>`).join('');
      return response.end(readFileSync(join(publicDir, filename), 'utf8').replace('<!-- website-links -->',
        () => items || '<p>Sem testes disponíveis.</p>'));
    }
    response.end(request.method === 'HEAD' ? undefined : readFileSync(join(publicDir, filename)));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof InputError ? 400 : 500;
    if (status === 500) console.error(error);
    if (!response.headersSent && !response.destroyed) {
      json(response, { error: status === 500 ? 'Ocorreu um erro. Tente novamente.' : error.message }, status);
    }
  }
}).listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Estudo online disponível na porta ${process.env.PORT || 3000}`);
});
