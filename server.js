const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const root = __dirname;
const databasePath = path.join(root, 'db.json');
const port = Number(process.env.PORT) || 3000;
const cookieName = 'atelier_session';
const sessionDuration = 8 * 60 * 60 * 1000;
const sessions = new Map();
const scrypt = promisify(crypto.scrypt);
const pepper = process.env.PASSWORD_PEPPER || 'change-this-development-pepper';
const publicFiles = new Set(['/','/index.html','/login.html','/auth.html','/auth.js','/styles.css']);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

if (!process.env.PASSWORD_PEPPER) {
  console.warn('AVERTISSEMENT : définissez PASSWORD_PEPPER dans l’environnement avant un déploiement réel.');
}

function readDatabase() {
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, JSON.stringify({ users: [] }, null, 2));
  const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  if (!Array.isArray(database.users)) throw new Error('Le fichier db.json doit contenir un tableau users.');
  return database;
}

function writeDatabase(database) {
  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryPath, databasePath);
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error('Requête trop volumineuse.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Corps JSON invalide.'));
      }
    });
    request.on('error', reject);
  });
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || '';
  const entry = cookies.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
}

function setSessionCookie(response, sessionId) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secure}`);
}

function getSessionUser(request) {
  const sessionId = getCookie(request, cookieName);
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  const user = readDatabase().users.find((entry) => entry.email === session.email);
  return user ? { email: user.email, auteur: user.auteur === true } : null;
}

async function handleApi(request, response, pathname) {
  if (request.method === 'POST' && pathname === '/api/register') {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 128) {
      sendJson(response, 400, { error: 'Saisissez une adresse e-mail valide et un mot de passe de 8 à 128 caractères.' });
      return;
    }

    const database = readDatabase();
    if (database.users.some((user) => user.email === email)) {
      sendJson(response, 409, { error: 'Un compte existe déjà avec cette adresse e-mail.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(`${password}${pepper}`, salt, 64)).toString('hex');
    database.users.push({ email, passwordHash, salt, auteur: false });
    writeDatabase(database);
    sendJson(response, 201, { message: 'Compte créé.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = readDatabase().users.find((entry) => entry.email === email);
    if (!user || typeof user.salt !== 'string' || typeof user.passwordHash !== 'string') {
      sendJson(response, 401, { error: 'Adresse e-mail ou mot de passe incorrect.' });
      return;
    }

    const candidate = (await scrypt(`${password}${pepper}`, user.salt, 64));
    const expected = Buffer.from(user.passwordHash, 'hex');
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      sendJson(response, 401, { error: 'Adresse e-mail ou mot de passe incorrect.' });
      return;
    }

    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, { email: user.email, expiresAt: Date.now() + sessionDuration });
    setSessionCookie(response, sessionId);
    sendJson(response, 200, { user: { email: user.email, auteur: user.auteur === true } });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/me') {
    const user = getSessionUser(request);
    sendJson(response, user ? 200 : 401, user ? { user } : { error: 'Connexion requise.' });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    sessions.delete(getCookie(request, cookieName));
    response.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    sendJson(response, 200, { message: 'Déconnexion effectuée.' });
    return;
  }

  sendJson(response, 404, { error: 'Route API introuvable.' });
}

const server = http.createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  } catch {
    sendJson(response, 400, { error: 'Requête invalide.' });
    return;
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, pathname);
    } catch (error) {
      console.error('Erreur API :', error);
      if (!response.headersSent) sendJson(response, 500, { error: 'Erreur interne du serveur.' });
    }
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method) || !publicFiles.has(pathname)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page introuvable');
    return;
  }

  const isLoginPage = pathname === '/' || pathname === '/login.html';
  const filePath = isLoginPage ? path.join(root, 'auth.html') : path.join(root, pathname.slice(1));
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Erreur serveur');
      return;
    }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)], 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
});

server.listen(port, () => {
  console.log(`Site disponible sur http://localhost:${port}`);
});
