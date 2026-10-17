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
const publicFiles = new Set(['/','/index.html','/login.html','/auth.html','/auth.js','/styles.css','/articles.html','/write-article.html','/admin.html']);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

if (!process.env.PASSWORD_PEPPER) {
  console.warn('AVERTISSEMENT : définissez PASSWORD_PEPPER dans l’environnement avant un déploiement réel.');
}

function readDatabase() {
  if (!fs.existsSync(databasePath)) fs.writeFileSync(databasePath, JSON.stringify({ users: [], articles: [] }, null, 2));
  const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  if (!Array.isArray(database.users)) throw new Error('Le fichier db.json doit contenir un tableau users.');
  if (!Array.isArray(database.articles)) database.articles = [];
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
      if (body.length > 100_000) {
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
  return user ? {
    email: user.email,
    auteur: user.auteur === true,
    admin: user.admin === true || (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === user.email,
    demandeAuteur: user.demandeAuteur || 'aucune',
  } : null;
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
    database.users.push({ email, passwordHash, salt, auteur: false, demandeAuteur: 'aucune' });
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

  if (request.method === 'POST' && pathname === '/api/author-request') {
    const user = getSessionUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Connectez-vous pour demander le droit auteur.' });
      return;
    }
    if (user.auteur) {
      sendJson(response, 400, { error: 'Votre compte possède déjà le droit auteur.' });
      return;
    }
    if (user.demandeAuteur === 'en_attente') {
      sendJson(response, 409, { error: 'Votre demande est déjà en attente de validation.' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    const texteDemande = typeof body.texte === 'string' ? body.texte.trim() : '';
    if (!texteDemande || texteDemande.length > 200) {
      sendJson(response, 400, { error: 'Saisissez un message de motivation de 200 caractères maximum.' });
      return;
    }
    const database = readDatabase();
    const target = database.users.find((entry) => entry.email === user.email);
    if (!target) {
      sendJson(response, 404, { error: 'Utilisateur introuvable.' });
      return;
    }
    target.demandeAuteur = 'en_attente';
    target.texteDemandeAuteur = texteDemande;
    writeDatabase(database);
    sendJson(response, 200, { demandeAuteur: target.demandeAuteur, texteDemandeAuteur: target.texteDemandeAuteur });
    return;
  }

  if (pathname.startsWith('/api/admin/')) {
    const user = getSessionUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Connexion requise.' });
      return;
    }
    if (!user.admin) {
      sendJson(response, 403, { error: 'Accès réservé à l’administration.' });
      return;
    }

    const database = readDatabase();
    if (request.method === 'GET' && pathname === '/api/admin/users') {
      const users = database.users.map(({ email, auteur, admin }) => ({
        email,
        auteur: auteur === true,
        admin: admin === true || (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === email,
        demandeAuteur: database.users.find((entry) => entry.email === email)?.demandeAuteur || 'aucune',
        texteDemandeAuteur: database.users.find((entry) => entry.email === email)?.texteDemandeAuteur || '',
      }));
      sendJson(response, 200, { users });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/admin/articles') {
      const articles = database.articles
        .slice()
        .sort((first, second) => Date.parse(second.date) - Date.parse(first.date));
      sendJson(response, 200, { articles });
      return;
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (request.method === 'DELETE' && userMatch) {
      const email = userMatch[1].trim().toLowerCase();
      if (email === user.email) {
        sendJson(response, 400, { error: 'Vous ne pouvez pas supprimer votre propre compte.' });
        return;
      }
      const target = database.users.find((entry) => entry.email === email);
      if (!target) {
        sendJson(response, 404, { error: 'Utilisateur introuvable.' });
        return;
      }
      const targetIsAdmin = target.admin === true || (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === target.email;
      const admins = database.users.filter((entry) => entry.admin === true || (process.env.ADMIN_EMAIL || '').trim().toLowerCase() === entry.email);
      if (targetIsAdmin && admins.length <= 1) {
        sendJson(response, 400, { error: 'Impossible de supprimer le dernier administrateur.' });
        return;
      }
      database.users = database.users.filter((entry) => entry.email !== email);
      writeDatabase(database);
      for (const [sessionId, session] of sessions) {
        if (session.email === email) sessions.delete(sessionId);
      }
      sendJson(response, 200, { message: 'Utilisateur supprimé.' });
      return;
    }
    if (request.method === 'PATCH' && userMatch) {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (!['accepter', 'refuser'].includes(body.decision)) {
        sendJson(response, 400, { error: 'Choisissez d’accepter ou de refuser la demande auteur.' });
        return;
      }
      const target = database.users.find((entry) => entry.email === userMatch[1].trim().toLowerCase());
      if (!target) {
        sendJson(response, 404, { error: 'Utilisateur introuvable.' });
        return;
      }
      if (target.demandeAuteur !== 'en_attente') {
        sendJson(response, 409, { error: 'Cet utilisateur n’a pas de demande auteur en attente.' });
        return;
      }
      target.auteur = body.decision === 'accepter';
      target.demandeAuteur = body.decision === 'accepter' ? 'acceptee' : 'refusee';
      writeDatabase(database);
      sendJson(response, 200, { user: { email: target.email, auteur: target.auteur === true, demandeAuteur: target.demandeAuteur } });
      return;
    }

    const articleMatch = pathname.match(/^\/api\/admin\/articles\/([^/]+)$/);
    if (request.method === 'DELETE' && articleMatch) {
      const index = database.articles.findIndex((article) => article.id === articleMatch[1]);
      if (index === -1) {
        sendJson(response, 404, { error: 'Article introuvable.' });
        return;
      }
      database.articles.splice(index, 1);
      writeDatabase(database);
      sendJson(response, 200, { message: 'Article supprimé.' });
      return;
    }
    if (request.method === 'PATCH' && articleMatch) {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      if (typeof body.publier !== 'boolean') {
        sendJson(response, 400, { error: 'Indiquez si l’article doit être publié.' });
        return;
      }
      const article = database.articles.find((entry) => entry.id === articleMatch[1]);
      if (!article) {
        sendJson(response, 404, { error: 'Article introuvable.' });
        return;
      }
      article.publier = body.publier;
      writeDatabase(database);
      sendJson(response, 200, { article });
      return;
    }
    sendJson(response, 404, { error: 'Route d’administration introuvable.' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/articles') {
    const database = readDatabase();
    const articles = database.articles
      .filter((article) => article.publier === true)
      .sort((first, second) => Date.parse(second.date) - Date.parse(first.date));
    sendJson(response, 200, { articles });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/articles') {
    const user = getSessionUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Connectez-vous pour écrire un article.' });
      return;
    }
    if (!user.auteur) {
      sendJson(response, 403, { error: 'Seuls les auteurs peuvent ajouter un article.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    const titre = typeof body.titre === 'string' ? body.titre.trim() : '';
    const article = typeof body.article === 'string' ? body.article.trim() : '';
    if (!titre || titre.length > 160 || !article || article.length > 20_000 || typeof body.publier !== 'boolean') {
      sendJson(response, 400, { error: 'Saisissez un titre (160 caractères maximum), un article (20 000 caractères maximum) et un choix de publication.' });
      return;
    }

    const database = readDatabase();
    const newArticle = {
      id: crypto.randomUUID(),
      titre,
      article,
      date: new Date().toISOString(),
      publier: body.publier,
      auteur: user.email,
    };
    database.articles.push(newArticle);
    writeDatabase(database);
    sendJson(response, 201, { article: newArticle });
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
