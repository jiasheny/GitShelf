import { useState, useEffect } from 'preact/hooks';

const PASSWORD_HASH = import.meta.env.VITE_SITE_PASSWORD_HASH || '';
const SESSION_KEY = 'site_authenticated';

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function PasswordGate({ children }) {
  const [authenticated, setAuthenticated] = useState(() => {
    if (!PASSWORD_HASH) return true;
    return sessionStorage.getItem(SESSION_KEY) === 'true';
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (authenticated) return children;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('请输入密码');
      return;
    }
    setLoading(true);
    setError('');
    const hash = await sha256(password.trim());
    if (hash === PASSWORD_HASH.toLowerCase()) {
      sessionStorage.setItem(SESSION_KEY, 'true');
      setAuthenticated(true);
    } else {
      setError('密码错误');
    }
    setLoading(false);
  };

  return (
    <div class="admin-auth">
      <h2>访问验证</h2>
      <p>请输入密码以访问本站内容。</p>
      <p class="admin-auth-note">提示：这是浏览界面锁，不会隐藏公开 GitHub 仓库中的原始文件。</p>
      <form onSubmit={handleSubmit}>
        <div class="admin-input-group">
          <input
            type="password"
            class="admin-pat-input"
            value={password}
            onInput={(e) => setPassword(e.target.value)}
            placeholder="输入密码"
            autocomplete="off"
            aria-label="站点访问密码"
          />
          <button class="btn btn-primary" type="submit" disabled={loading}>
            {loading ? <><span class="spinner" /> 验证中…</> : '确认'}
          </button>
        </div>
      </form>
      {error && <p class="admin-error">{error}</p>}
    </div>
  );
}
