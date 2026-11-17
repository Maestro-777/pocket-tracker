const USERS_KEY = 'expLocalUsersV1';
const SESSION_KEY = 'expLocalSessionV1';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const ITERATIONS = 210000;
const ROLES = Object.freeze({
  owner: ['*'],
  trader: ['dashboard:read', 'trade:execute', 'strategies:read', 'strategies:write', 'statistics:read', 'settings:write'],
  viewer: ['dashboard:read', 'strategies:read', 'statistics:read']
});

const now = () => Date.now();
const id = () => crypto.randomUUID();
const normalizeLogin = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (value) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

async function derivePassword(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, 256);
  return encode(bits);
}

async function readUsers() {
  const data = await chrome.storage.local.get(USERS_KEY);
  return Array.isArray(data[USERS_KEY]) ? data[USERS_KEY] : [];
}

export async function getCurrentUser() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  const session = data[SESSION_KEY];
  if (!session || Number(session.expiresAt) <= now()) {
    if (session) await chrome.storage.local.remove(SESSION_KEY);
    return null;
  }
  const users = await readUsers();
  const user = users.find(item => item.id === session.userId && item.disabled !== true);
  return user ? { id: user.id, login: user.login, role: user.role, createdAt: user.createdAt } : null;
}

export async function hasPermission(permission) {
  const user = await getCurrentUser();
  if (!user) return false;
  const grants = ROLES[user.role] || [];
  return grants.includes('*') || grants.includes(permission);
}

export async function getLocalAccessSnapshot() {
  const user = await getCurrentUser();
  const users = await readUsers();
  return {
    authenticated: Boolean(user),
    user,
    userCount: users.length,
    roles: Object.keys(ROLES),
    permissions: user ? (ROLES[user.role] || []) : []
  };
}

export async function createLocalUser({ login, password, role = 'trader' } = {}) {
  const normalized = normalizeLogin(login);
  if (normalized.length < 3) throw new Error('Логин: минимум 3 символа (латиница, цифры, . _ -).');
  if (String(password || '').length < 10) throw new Error('Пароль должен содержать минимум 10 символов.');
  if (!Object.hasOwn(ROLES, role) || role === 'owner') throw new Error('Недопустимая роль.');
  const users = await readUsers();
  const current = await getCurrentUser();
  if (users.length && (!current || current.role !== 'owner')) throw new Error('Создавать пользователей может только владелец.');
  if (users.some(user => user.login === normalized)) throw new Error('Такой логин уже существует.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const record = {
    id: id(), login: normalized, role: users.length ? role : 'owner',
    salt: encode(salt), passwordHash: await derivePassword(password, salt),
    createdAt: new Date().toISOString(), disabled: false
  };
  users.push(record);
  await chrome.storage.local.set({ [USERS_KEY]: users });
  await chrome.storage.local.set({ [SESSION_KEY]: { userId: record.id, createdAt: now(), expiresAt: now() + SESSION_TTL } });
  return { id: record.id, login: record.login, role: record.role, createdAt: record.createdAt };
}

export async function loginLocalUser({ login, password } = {}) {
  const normalized = normalizeLogin(login);
  const users = await readUsers();
  const user = users.find(item => item.login === normalized && item.disabled !== true);
  if (!user) throw new Error('Неверный логин или пароль.');
  const candidate = await derivePassword(password, decode(user.salt));
  if (candidate !== user.passwordHash) throw new Error('Неверный логин или пароль.');
  await chrome.storage.local.set({ [SESSION_KEY]: { userId: user.id, createdAt: now(), expiresAt: now() + SESSION_TTL } });
  return { id: user.id, login: user.login, role: user.role, createdAt: user.createdAt };
}

export async function logoutLocalUser() {
  await chrome.storage.local.remove(SESSION_KEY);
  return { ok: true };
}

export async function listLocalUsers() {
  const current = await getCurrentUser();
  if (!current || current.role !== 'owner') throw new Error('Недостаточно прав.');
  return (await readUsers()).map(({ id, login, role, createdAt, disabled }) => ({ id, login, role, createdAt, disabled: Boolean(disabled) }));
}

export async function setLocalUserRole(userId, role) {
  const current = await getCurrentUser();
  if (!current || current.role !== 'owner') throw new Error('Недостаточно прав.');
  if (!['trader', 'viewer'].includes(role)) throw new Error('Роль может быть trader или viewer.');
  const users = await readUsers();
  const target = users.find(user => user.id === userId);
  if (!target || target.role === 'owner') throw new Error('Пользователь не найден или защищён.');
  target.role = role;
  await chrome.storage.local.set({ [USERS_KEY]: users });
  return { id: target.id, login: target.login, role: target.role };
}

export async function disableLocalUser(userId, disabled = true) {
  const current = await getCurrentUser();
  if (!current || current.role !== 'owner') throw new Error('Недостаточно прав.');
  const users = await readUsers();
  const target = users.find(user => user.id === userId);
  if (!target || target.role === 'owner') throw new Error('Пользователь не найден или защищён.');
  target.disabled = Boolean(disabled);
  await chrome.storage.local.set({ [USERS_KEY]: users });
  return { id: target.id, login: target.login, disabled: target.disabled };
}

export async function initializeLocalUsers() {
  const users = await readUsers();
  return { needsOwnerSetup: users.length === 0, ...(await getLocalAccessSnapshot()) };
}

if (typeof document !== 'undefined' && document.documentElement?.dataset?.localUsersPage === 'true') {
  const $ = id => document.getElementById(id);
  const form = $('authForm');
  const status = $('status');
  const submit = $('submitAuth');
  const logout = $('logout');
  const ownerTools = $('ownerTools');
  const userList = $('userList');
  let setupMode = false;

  async function refresh() {
    const snapshot = await initializeLocalUsers();
    setupMode = snapshot.needsOwnerSetup;
    $('pageTitle').textContent = setupMode ? 'Создать владельца' : (snapshot.user ? 'Локальный профиль' : 'Вход в расширение');
    $('authHint').textContent = setupMode
      ? 'Первый созданный пользователь автоматически получает роль owner.'
      : 'Учётные записи и роли хранятся только в локальном профиле Chrome.';
    if ($('roleField')) $('roleField').hidden = !snapshot.user || snapshot.user.role !== 'owner';
    form.hidden = Boolean(snapshot.user);
    logout.hidden = !snapshot.user;
    if (snapshot.user) {
      $('currentUser').textContent = snapshot.user.login + ' · ' + snapshot.user.role;
      ownerTools.hidden = snapshot.user.role !== 'owner';
      if (snapshot.user.role === 'owner') await renderUsers();
    } else {
      ownerTools.hidden = true;
    }
  }

  async function renderUsers() {
    const users = await listLocalUsers();
    userList.replaceChildren();
    for (const user of users) {
      const row = document.createElement('div');
      row.className = 'userRow';
      const label = document.createElement('span');
      label.textContent = user.login + ' · ' + user.role + (user.disabled ? ' · отключён' : '');
      row.append(label);
      if (user.role !== 'owner') {
        const select = document.createElement('select');
        for (const role of ['trader', 'viewer']) {
          const option = document.createElement('option');
          option.value = role; option.textContent = role; option.selected = user.role === role;
          select.append(option);
        }
        select.addEventListener('change', async () => { await setLocalUserRole(user.id, select.value); await renderUsers(); });
        row.append(select);
        const toggle = document.createElement('button');
        toggle.textContent = user.disabled ? 'Включить' : 'Отключить';
        toggle.addEventListener('click', async () => { await disableLocalUser(user.id, !user.disabled); await renderUsers(); });
        row.append(toggle);
      }
      userList.append(row);
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      if (setupMode) await createLocalUser(values);
      else await loginLocalUser(values);
      status.textContent = 'Готово. Локальный вход выполнен.';
      form.reset();
      await refresh();
    } catch (error) { status.textContent = error.message || String(error); }
    finally { submit.disabled = false; }
  });

  $('createUserForm').addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await createLocalUser(values);
      event.currentTarget.reset();
      status.textContent = 'Пользователь создан.';
      await renderUsers();
    } catch (error) { status.textContent = error.message || String(error); }
  });
  logout.addEventListener('click', async () => { await logoutLocalUser(); await refresh(); });
  refresh().catch(error => { status.textContent = error.message || String(error); });
}
