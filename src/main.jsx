import { render } from 'preact';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import './style.css';
import { App } from './components/App';
import { PasswordGate } from './components/PasswordGate';
import { clearLegacyCredentials } from './lib/security-bootstrap';

clearLegacyCredentials();

render(
  <PasswordGate>
    <App />
  </PasswordGate>,
  document.getElementById('app'),
);
