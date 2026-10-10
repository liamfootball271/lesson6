const SESSION_PATH = '/api/me';

async function requestApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Une erreur est survenue.');
  return payload;
}

function displayMessage(element, message, success = false) {
  element.textContent = message;
  element.classList.toggle('is-success', success);
}

function initAuthPage() {
  const loginForm = document.querySelector('#login-form');
  const registerForm = document.querySelector('#register-form');
  const loginMessage = document.querySelector('#login-message');
  const registerMessage = document.querySelector('#register-message');

  function openTab(name) {
    const isLogin = name === 'login';
    loginForm.hidden = !isLogin;
    registerForm.hidden = isLogin;
    document.querySelector('#login-tab').classList.toggle('is-active', isLogin);
    document.querySelector('#register-tab').classList.toggle('is-active', !isLogin);
    document.querySelector('#login-tab').setAttribute('aria-selected', String(isLogin));
    document.querySelector('#register-tab').setAttribute('aria-selected', String(!isLogin));
    document.querySelector('#form-title').textContent = isLogin ? 'Ravi de vous revoir' : 'Rejoignez-nous';
    document.querySelector('#form-subtitle').textContent = isLogin
      ? 'Entrez vos informations pour vous connecter.'
      : 'Créez votre compte en quelques secondes.';
    history.replaceState(null, '', isLogin ? '#connexion' : '#inscription');
  }

  document.querySelectorAll('[data-tab], [data-open-tab]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      if (trigger.matches('[data-open-tab]')) event.preventDefault();
      openTab(trigger.dataset.tab || trigger.dataset.openTab);
    });
  });

  requestApi(SESSION_PATH).then(() => {
    window.location.replace('index.html');
  }).catch(() => {
    openTab(window.location.hash === '#inscription' ? 'register' : 'login');
  });

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    displayMessage(registerMessage, '');
    const data = new FormData(registerForm);
    try {
      await requestApi('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          email: String(data.get('email')).trim().toLowerCase(),
          password: String(data.get('password')),
        }),
      });
      const email = String(data.get('email')).trim().toLowerCase();
      registerForm.reset();
      document.querySelector('#login-email').value = email;
      openTab('login');
      displayMessage(loginMessage, 'Compte créé ! Vous pouvez maintenant vous connecter.', true);
    } catch (error) {
      displayMessage(registerMessage, error.message);
    }
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    displayMessage(loginMessage, '');
    const data = new FormData(loginForm);
    try {
      await requestApi('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          email: String(data.get('email')).trim().toLowerCase(),
          password: String(data.get('password')),
        }),
      });
      window.location.assign('index.html');
    } catch (error) {
      displayMessage(loginMessage, error.message);
    }
  });
}

async function initHomePage() {
  const logoutButton = document.querySelector('#logout-button');
  try {
    const { user } = await requestApi(SESSION_PATH);
    document.querySelector('#user-name').textContent = user.email;
    document.querySelector('#home-write-link').hidden = !user.auteur;
    document.querySelector('#welcome-title').innerHTML = 'Vous êtes connecté<span class="accent-dot">.</span>';
    document.querySelector('#welcome-copy').textContent = `Bienvenue dans votre espace personnel, ${user.email}.`;
    document.querySelector('#session-status').textContent = user.auteur ? 'Votre session auteur est active' : 'Votre session est active';
    logoutButton.addEventListener('click', async () => {
      try {
        await requestApi('/api/logout', { method: 'POST' });
      } finally {
        window.location.replace('/auth.html');
      }
    });
  } catch {
    window.location.replace('/auth.html');
  }
}

function formatArticleDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date inconnue' : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(date);
}

function createArticleCard(article, isAuthor) {
  const card = document.createElement('article');
  card.className = 'article-card';

  const meta = document.createElement('div');
  meta.className = 'article-meta';
  const date = document.createElement('time');
  date.dateTime = article.date;
  date.textContent = formatArticleDate(article.date);
  meta.append(date);
  if (isAuthor) {
    const status = document.createElement('span');
    status.className = `article-status${article.publier ? ' is-published' : ''}`;
    status.textContent = article.publier ? 'Publié' : 'Brouillon';
    meta.append(status);
  }

  const title = document.createElement('h2');
  title.textContent = article.titre;
  const content = document.createElement('p');
  content.className = 'article-body';
  content.textContent = article.article;
  card.append(meta, title, content);

  if (article.auteur) {
    const author = document.createElement('p');
    author.className = 'article-author';
    author.textContent = `Par ${article.auteur}`;
    card.append(author);
  }
  return card;
}

async function initArticlesPage() {
  const list = document.querySelector('#article-list');
  const writerLink = document.querySelector('#write-article-link');
  let isAuthor = false;
  try {
    const { user } = await requestApi(SESSION_PATH);
    isAuthor = user.auteur;
    writerLink.hidden = !isAuthor;
  } catch {
    // La consultation des articles publiés reste ouverte sans connexion.
  }

  try {
    const { articles } = await requestApi('/api/articles');
    list.replaceChildren();
    if (articles.length === 0) {
      const empty = document.createElement('section');
      empty.className = 'empty-state';
      const heading = document.createElement('h2');
      heading.textContent = 'Aucun article pour le moment';
      const message = document.createElement('p');
      message.textContent = isAuthor ? 'Vous pouvez rédiger le premier article.' : 'Les articles publiés apparaîtront ici.';
      empty.append(heading, message);
      list.append(empty);
      return;
    }
    articles.forEach((article) => list.append(createArticleCard(article, isAuthor)));
  } catch (error) {
    const message = document.createElement('p');
    message.className = 'empty-state';
    message.textContent = error.message;
    list.replaceChildren(message);
  }
}

async function initComposerPage() {
  const form = document.querySelector('#article-form');
  const accessPanel = document.querySelector('#composer-access');
  const accessTitle = document.querySelector('#composer-access-title');
  const accessMessage = document.querySelector('#composer-access-message');
  const accessLink = document.querySelector('#composer-access-link');
  const message = document.querySelector('#article-message');

  try {
    const { user } = await requestApi(SESSION_PATH);
    if (!user.auteur) {
      accessTitle.textContent = 'Accès réservé aux auteurs';
      accessMessage.textContent = 'Votre compte est connecté, mais il ne possède pas le droit auteur.';
      accessLink.textContent = 'Retour aux articles';
      accessLink.href = 'articles.html';
      accessPanel.hidden = false;
      return;
    }
    form.hidden = false;
  } catch {
    accessTitle.textContent = 'Connexion requise';
    accessMessage.textContent = 'Connectez-vous avec un compte auteur pour écrire un article.';
    accessPanel.hidden = false;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    displayMessage(message, '');
    const data = new FormData(form);
    try {
      await requestApi('/api/articles', {
        method: 'POST',
        body: JSON.stringify({
          titre: String(data.get('titre')),
          article: String(data.get('article')),
          publier: data.get('publier') === 'true',
        }),
      });
      window.location.assign('articles.html');
    } catch (error) {
      displayMessage(message, error.message);
    }
  });
}

if (document.body.dataset.page === 'auth') initAuthPage();
if (document.body.dataset.page === 'home') initHomePage();
if (document.body.dataset.page === 'articles') initArticlesPage();
if (document.body.dataset.page === 'composer') initComposerPage();
