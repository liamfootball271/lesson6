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

if (document.body.dataset.page === 'auth') initAuthPage();
if (document.body.dataset.page === 'home') initHomePage();
