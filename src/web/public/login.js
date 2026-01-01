// Login: passkey sign-in, #enrol=<token> registers a new passkey, #operator=<token> redeems an operator link.
(() => {
  // Back to the email alert that sent Owner here; nothing else may be a target.
  const after = () => { const next = new URLSearchParams(location.search).get('next') || ''; return /^\/chat\/mail\/[a-f0-9]{24}$/.test(next) ? next : '/'; };
  'use strict';
  const button = document.getElementById('passkey');
  const status = document.getElementById('status');
  const heading = document.getElementById('heading');
  const intro = document.getElementById('intro');
  let enrollment = null;

  const request = async (step, body) => {
    const res = await fetch('/auth/' + step, {method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-Mastan-Me': '1'}, body: JSON.stringify(body)});
    if (res.status === 429) throw new Error('Too many attempts. Wait five minutes.');
    if (!res.ok) throw new Error('Sign-in failed. Please try again.');
    return res.json();
  };

  let busyRedeem = false;
  async function redeemOperator(value) {
    busyRedeem = true;
    button.disabled = true;
    heading.textContent = 'Operator sign-in';
    intro.textContent = 'Checking the one-time link.';
    try {
      await request('operator', {token: value});
      location.replace(after());
    } catch (e) {
      intro.textContent = 'This link is used or expired.';
      status.textContent = e.message;
      button.disabled = false;
      heading.textContent = 'Mastan Me';
    }
  }

  function readFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    // The fragment never reaches access logs; drop it from history right away.
    if (location.hash) history.replaceState(null, '', location.pathname);
    const operator = params.get('operator');
    enrollment = params.get('enrol') || params.get('enroll');
    status.textContent = '';
    if (operator) { enrollment = null; redeemOperator(operator); return; }
    button.textContent = enrollment ? 'Set up a passkey' : 'Sign in with passkey';
    heading.textContent = enrollment ? 'Set up a passkey' : 'Mastan Me';
    intro.textContent = enrollment ? 'Use Face ID or Touch ID. This link works once.' : 'This page is private.';
  }

  readFragment();
  // Already signed in and no link to redeem: go to the atlas.
  if (!enrollment && !busyRedeem) fetch('/api/stats', {credentials: 'same-origin'}).then(r => { if (r.ok && !enrollment && !busyRedeem) location.replace(after()); }).catch(() => {});
  window.addEventListener('hashchange', readFragment);

  button.addEventListener('click', async () => {
    if (!window.SimpleWebAuthnBrowser || !window.PublicKeyCredential) {
      status.textContent = 'This browser cannot use passkeys.';
      return;
    }
    button.disabled = true;
    status.textContent = '';
    try {
      const kind = enrollment ? 'register' : 'login';
      const options = await request(kind + '/options', enrollment ? {enrollment} : {});
      const response = enrollment
        ? await SimpleWebAuthnBrowser.startRegistration({optionsJSON: options})
        : await SimpleWebAuthnBrowser.startAuthentication({optionsJSON: options});
      await request(kind + '/verify', {response});
      location.replace(after());
    } catch (e) {
      const name = e && (e.name || e.code);
      status.textContent = name === 'NotAllowedError' || name === 'ERROR_CEREMONY_ABORTED' ? 'Cancelled. Try again when ready.'
        : name === 'InvalidStateError' ? 'This device already has a passkey here. Sign in instead.'
        : (e && e.message && e.message.startsWith('Too many')) ? e.message : 'Sign-in failed. Please try again.';
      if (enrollment && name === 'InvalidStateError') { enrollment = null; button.textContent = 'Sign in with passkey'; heading.textContent = 'Mastan Me'; }
      button.disabled = false;
    }
  });
})();
