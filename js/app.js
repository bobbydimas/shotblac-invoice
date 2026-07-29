/* ============================================================
   AGENCY INVOICER — Full Application Logic
   Storage · Utils · Router · Toast · Modal
   Dashboard · Editor · Preview · Settings
   ============================================================ */

'use strict';

// ============================================================
// STORAGE — localStorage CRUD layer
// ============================================================
const Storage = {
  INVOICES_KEY: 'agency_invoices_v1',
  SETTINGS_KEY: 'agency_settings_v1',

  getInvoices() {
    try {
      return JSON.parse(localStorage.getItem(this.INVOICES_KEY) || '[]');
    } catch { return []; }
  },

  saveInvoices(invoices) {
    localStorage.setItem(this.INVOICES_KEY, JSON.stringify(invoices));
    Cloud.syncInvoices(invoices);
  },

  getInvoice(id) {
    return this.getInvoices().find(inv => inv.id === id) || null;
  },

  saveInvoice(invoice) {
    const invoices = this.getInvoices();
    const idx = invoices.findIndex(inv => inv.id === invoice.id);
    if (idx === -1) {
      invoices.unshift(invoice);
    } else {
      invoices[idx] = invoice;
    }
    this.saveInvoices(invoices);
    return invoice;
  },

  deleteInvoice(id) {
    this.saveInvoices(this.getInvoices().filter(inv => inv.id !== id));
    Cloud.deleteInvoice(id);
  },

  EXPENSES_KEY: 'agency_expenses_v1',

  getExpenses() {
    try {
      return JSON.parse(localStorage.getItem(this.EXPENSES_KEY) || '[]');
    } catch { return []; }
  },

  saveExpenses(expenses) {
    localStorage.setItem(this.EXPENSES_KEY, JSON.stringify(expenses));
    Cloud.syncExpenses(expenses);
  },

  getExpense(id) {
    return this.getExpenses().find(exp => exp.id === id) || null;
  },

  saveExpense(expense) {
    const expenses = this.getExpenses();
    const idx = expenses.findIndex(exp => exp.id === expense.id);
    if (idx === -1) {
      expenses.unshift(expense);
    } else {
      expenses[idx] = expense;
    }
    this.saveExpenses(expenses);
    return expense;
  },

  deleteExpense(id) {
    this.saveExpenses(this.getExpenses().filter(exp => exp.id !== id));
    Cloud.deleteExpense(id);
  },

  getSettings() {
    const defaults = {
      agencyName:            'Your Creative Agency',
      agencyTagline:         'Creative Agency & Media Brand',
      agencyAddress:         '123 Creative Street\nLondon, UK EC1A 1BB',
      agencyEmail:           'hello@youragency.com',
      agencyPhone:           '+44 7000 000000',
      agencyWebsite:         'www.youragency.com',
      currency:              'GBP',
      currencySymbol:        '£',
      taxLabel:              'VAT',
      defaultTaxRate:        20,
      defaultPaymentTerms:   'Payment due within 30 days of the invoice date.',
      bankDetails:           'Bank: Barclays\nAccount Name: Your Agency Ltd\nAccount No: 00000000\nSort Code: 00-00-00\n\nPayment can also be made via bank transfer using the invoice number as reference.',
      logoUrl:               null,
      accentColor:           '#2a2a2a',
      accentColorSecondary:  '#111111',
      nextInvoiceNumber:     1,
    };
    try {
      const saved = JSON.parse(localStorage.getItem(this.SETTINGS_KEY) || '{}');
      return { ...defaults, ...saved };
    } catch { return defaults; }
  },

  saveSettings(settings) {
    localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings));
    Cloud.syncSettings(settings);
  },
};

// ============================================================
// CLOUD HISTORY — Supabase authentication and cross-device sync
// ============================================================
const Cloud = {
  LAST_EMAIL_KEY: 'agency_last_login_email',
  client: null,
  user: null,
  ready: false,

  async init() {
    try {
      if (!window.supabase || !window.SUPABASE_CONFIG?.url || !window.SUPABASE_CONFIG?.publishableKey) {
        this.showError('Cloud configuration is missing.');
        return;
      }
      this.client = window.supabase.createClient(
        window.SUPABASE_CONFIG.url,
        window.SUPABASE_CONFIG.publishableKey,
        { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
      );
      const callbackParams = new URLSearchParams(`${window.location.search}&${window.location.hash.slice(1)}`);
      const isPasswordRecovery = callbackParams.get('type') === 'recovery';
      const { data: { session } } = await this.client.auth.getSession();
      if (isPasswordRecovery && session?.user) {
        this.showPasswordSetup();
        return;
      }
      if (!session?.user) {
        this.showSignIn();
        return;
      }
      this.user = session.user;
      this.ready = true;
      await this.hydrate();
      initApp();
    } catch (error) {
      console.error('Cloud startup failed:', error);
      this.showError('Cloud history could not start. Check your connection and Supabase setup.');
    }
  },

  async hydrate() {
    const localInvoices = Storage.getInvoices();
    const localSettings = Storage.getSettings();
    const localExpenses = Storage.getExpenses();
    const [
      { data: remoteInvoices, error: invoiceError },
      { data: remoteSettings, error: settingsError },
      { data: remoteExpenses, error: expenseError },
    ] = await Promise.all([
      this.client.from('invoices').select('payload').eq('user_id', this.user.id).order('updated_at', { ascending: false }),
      this.client.from('settings').select('payload').eq('user_id', this.user.id).maybeSingle(),
      this.client.from('expenses').select('payload').eq('user_id', this.user.id).order('updated_at', { ascending: false }),
    ]);
    if (invoiceError || settingsError) {
      this.showError('Cloud history could not load. Run the supplied Supabase SQL, then refresh.');
      return;
    }
    if (remoteInvoices?.length) {
      localStorage.setItem(Storage.INVOICES_KEY, JSON.stringify(remoteInvoices.map(row => row.payload)));
    } else if (localInvoices.length) {
      await this.syncInvoices(localInvoices);
    }
    if (remoteSettings?.payload) {
      localStorage.setItem(Storage.SETTINGS_KEY, JSON.stringify(remoteSettings.payload));
    } else {
      await this.syncSettings(localSettings);
    }
    if (expenseError) {
      // Older Supabase projects may not have run the expenses migration yet —
      // don't block the whole app over it, expenses just stay local-only until they do.
      console.warn('Expense cloud sync unavailable. Run the updated supabase-schema.sql to enable it.', expenseError.message);
    } else if (remoteExpenses?.length) {
      localStorage.setItem(Storage.EXPENSES_KEY, JSON.stringify(remoteExpenses.map(row => row.payload)));
    } else if (localExpenses.length) {
      await this.syncExpenses(localExpenses);
    }
  },

  async syncInvoices(invoices) {
    if (!this.ready || !this.user) return;
    const rows = invoices.map(invoice => ({
      user_id: this.user.id,
      invoice_id: invoice.id,
      payload: invoice,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return;
    const { error } = await this.client.from('invoices').upsert(rows, { onConflict: 'user_id,invoice_id' });
    if (error) console.warn('Invoice sync failed:', error.message);
  },

  async deleteInvoice(invoiceId) {
    if (!this.ready || !this.user) return;
    const { error } = await this.client.from('invoices').delete().eq('user_id', this.user.id).eq('invoice_id', invoiceId);
    if (error) console.warn('Invoice delete sync failed:', error.message);
  },

  async syncExpenses(expenses) {
    if (!this.ready || !this.user) return;
    const rows = expenses.map(expense => ({
      user_id: this.user.id,
      expense_id: expense.id,
      payload: expense,
      updated_at: new Date().toISOString(),
    }));
    if (!rows.length) return;
    const { error } = await this.client.from('expenses').upsert(rows, { onConflict: 'user_id,expense_id' });
    if (error) console.warn('Expense sync failed:', error.message);
  },

  async deleteExpense(expenseId) {
    if (!this.ready || !this.user) return;
    const { error } = await this.client.from('expenses').delete().eq('user_id', this.user.id).eq('expense_id', expenseId);
    if (error) console.warn('Expense delete sync failed:', error.message);
  },

  async syncSettings(settings) {
    if (!this.ready || !this.user) return;
    const { error } = await this.client.from('settings').upsert({
      user_id: this.user.id,
      payload: settings,
      updated_at: new Date().toISOString(),
    });
    if (error) console.warn('Settings sync failed:', error.message);
  },

  showSignIn() {
    const lastEmail = localStorage.getItem(this.LAST_EMAIL_KEY);
    document.getElementById('app-main').innerHTML = `
      <section class="auth-screen">
        <div class="auth-card">
          <div class="auth-mark">AI</div>
          <p class="auth-kicker">PRIVATE WORKSPACE</p>
          <h1>Your invoice history, everywhere.</h1>
          <p>Sign in to securely open the same invoices on your phone and computer.</p>
          <div class="auth-tabs" role="tablist">
            <button class="auth-tab active" type="button" data-auth-tab="login">Log in</button>
            <button class="auth-tab" type="button" data-auth-tab="signup">Create account</button>
          </div>
          <form id="sign-in-form" class="auth-form">
            <label for="sign-in-email">Email address</label>
            <input id="sign-in-email" type="email" autocomplete="email" value="${Utils.escHtml(lastEmail || '')}" placeholder="you@company.com" required />
            <label for="sign-in-password">Password</label>
            <input id="sign-in-password" type="password" autocomplete="current-password" placeholder="Your password" required />
            <button class="btn btn-primary btn-lg" type="submit">Log in</button>
            <button id="forgot-password" class="auth-switch" type="button">Forgot or need to set a password?</button>
          </form>
          <form id="sign-up-form" class="auth-form auth-form-hidden">
            <label for="sign-up-email">Email address</label>
            <input id="sign-up-email" type="email" autocomplete="email" placeholder="you@company.com" required />
            <label for="sign-up-password">Password</label>
            <input id="sign-up-password" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required />
            <label for="sign-up-password-confirm">Confirm password</label>
            <input id="sign-up-password-confirm" type="password" autocomplete="new-password" placeholder="Repeat password" required />
            <button class="btn btn-primary btn-lg" type="submit">Create account</button>
          </form>
          <p id="auth-message" class="auth-message"></p>
        </div>
      </section>`;
    const showMessage = (message, isError = false) => {
      const target = document.getElementById('auth-message');
      target.textContent = message;
      target.classList.toggle('error', isError);
    };
    document.getElementById('sign-in-form').addEventListener('submit', async event => {
      event.preventDefault();
      const email = document.getElementById('sign-in-email').value.trim();
      const password = document.getElementById('sign-in-password').value;
      const { error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) return showMessage(error.message, true);
      localStorage.setItem(this.LAST_EMAIL_KEY, email);
      window.location.reload();
    });
    document.getElementById('sign-up-form').addEventListener('submit', async event => {
      event.preventDefault();
      const email = document.getElementById('sign-up-email').value.trim();
      const password = document.getElementById('sign-up-password').value;
      if (password !== document.getElementById('sign-up-password-confirm').value) return showMessage('Passwords do not match.', true);
      const { data, error } = await this.client.auth.signUp({
        email, password, options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) return showMessage(error.message, true);
      localStorage.setItem(this.LAST_EMAIL_KEY, email);
      if (data.session) return window.location.reload();
      showMessage('Account created. Check your email to confirm it, then log in with your password.');
    });
    document.getElementById('forgot-password').addEventListener('click', async () => {
      const email = document.getElementById('sign-in-email').value.trim();
      if (!email) return showMessage('Enter your email address first, then select this option.', true);
      const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
      showMessage(error ? error.message : 'Check your email for a link to set a new password.', Boolean(error));
    });
    document.querySelectorAll('[data-auth-tab]').forEach(button => button.addEventListener('click', () => {
      const isLogin = button.dataset.authTab === 'login';
      document.querySelectorAll('[data-auth-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
      document.getElementById('sign-in-form').classList.toggle('auth-form-hidden', !isLogin);
      document.getElementById('sign-up-form').classList.toggle('auth-form-hidden', isLogin);
    }));
  },

  showPasswordSetup() {
    document.getElementById('app-main').innerHTML = `
      <section class="auth-screen"><div class="auth-card">
        <div class="auth-mark">AI</div><p class="auth-kicker">PASSWORD SETUP</p>
        <h1>Set your password</h1><p>Create a password to use for future logins.</p>
        <form id="password-setup-form" class="auth-form">
          <label for="new-password">New password</label>
          <input id="new-password" type="password" autocomplete="new-password" minlength="8" required />
          <label for="new-password-confirm">Confirm password</label>
          <input id="new-password-confirm" type="password" autocomplete="new-password" minlength="8" required />
          <button class="btn btn-primary btn-lg" type="submit">Save password</button>
        </form><p id="auth-message" class="auth-message"></p>
      </div></section>`;
    document.getElementById('password-setup-form').addEventListener('submit', async event => {
      event.preventDefault();
      const password = document.getElementById('new-password').value;
      const message = document.getElementById('auth-message');
      if (password !== document.getElementById('new-password-confirm').value) {
        message.textContent = 'Passwords do not match.'; message.classList.add('error'); return;
      }
      const { error } = await this.client.auth.updateUser({ password });
      if (error) { message.textContent = error.message; message.classList.add('error'); return; }
      history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
      window.location.reload();
    });
  },

  showError(message) {
    document.getElementById('app-main').innerHTML = `<div class="auth-screen"><div class="auth-card"><h1>Setup needed</h1><p>${Utils.escHtml(message)}</p></div></div>`;
  },
};

// ============================================================
// UTILS — helpers
// ============================================================
const Utils = {
  generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  },

  formatCurrency(amount, settings) {
    const sym = settings?.currencySymbol || '£';
    const val = parseFloat(amount || 0);
    return `${sym}${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric'
      });
    } catch { return dateStr; }
  },

  today() {
    return new Date().toISOString().slice(0, 10);
  },

  addDays(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  },

  generateInvoiceNumber(settings) {
    const year = new Date().getFullYear();
    const num = String(settings.nextInvoiceNumber).padStart(4, '0');
    return `INV-${year}-${num}`;
  },

  calculateTotals(items, discountType, discountValue, taxRate = 0) {
    const subtotal = items.reduce((sum, item) => {
      return sum + (parseFloat(item.quantity || 0) * parseFloat(item.unitPrice || 0));
    }, 0);

    const taxAmount = subtotal * (parseFloat(taxRate || 0) / 100);

    let discountAmount = 0;
    if (discountType === 'percentage') {
      discountAmount = subtotal * (parseFloat(discountValue || 0) / 100);
    } else {
      discountAmount = parseFloat(discountValue || 0);
    }
    discountAmount = Math.max(0, discountAmount);

    return { subtotal, taxAmount, discountAmount, total: subtotal + taxAmount - discountAmount };
  },

  isOverdue(invoice) {
    if (!invoice.dueDate || invoice.status === 'paid') return false;
    return new Date(invoice.dueDate + 'T23:59:59') < new Date();
  },

  escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};

// ============================================================
// EXPENSE CATEGORIES
// ============================================================
const EXPENSE_CATEGORIES = [
  'Equipment',
  'Software & Subscriptions',
  'Crew & Talent',
  'Location & Studio',
  'Travel & Transport',
  'Marketing & Ads',
  'Office & Admin',
  'Other',
];

// ============================================================
// ROUTER — hash-based client-side routing
// ============================================================
const Router = {
  routes: {},

  on(path, handler) {
    this.routes[path] = handler;
    return this;
  },

  navigate(path) {
    window.location.hash = path;
  },

  back() {
    history.back();
  },

  init() {
    window.addEventListener('hashchange', () => this._handle());
    this._handle();
  },

  _handle() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    const parts = hash.split('/');
    const route = parts[0];
    const param  = parts.slice(1).join('/');

    document.querySelectorAll('[data-route]').forEach(el => {
      el.classList.toggle('active', el.dataset.route === route);
    });

    const handler = this.routes[route];
    if (handler) handler(param);
    else this.navigate('dashboard');
  },
};

// ============================================================
// TOAST — lightweight notification system
// ============================================================
const Toast = {
  show(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', info: 'i' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span>${Utils.escHtml(message)}</span>
    `;
    container.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('visible'));
    });

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  },
};

// ============================================================
// MODAL — confirmation dialogs
// ============================================================
const Modal = {
  show(config) {
    const overlay  = document.getElementById('modal-overlay');
    const title    = document.getElementById('modal-title');
    const body     = document.getElementById('modal-body');
    const confirm  = document.getElementById('modal-confirm');
    const cancel   = document.getElementById('modal-cancel');
    const closeBtn = document.getElementById('modal-close');

    title.textContent  = config.title || 'Confirm';
    body.innerHTML     = config.body  || '';
    confirm.textContent = config.confirmText || 'Confirm';
    confirm.className  = `btn btn-${config.confirmClass || 'primary'}`;
    cancel.textContent = config.cancelText || 'Cancel';

    overlay.classList.add('visible');

    const cleanup = () => overlay.classList.remove('visible');

    // Clone to remove old listeners
    const newConfirm = confirm.cloneNode(true);
    const newCancel  = cancel.cloneNode(true);
    const newClose   = closeBtn.cloneNode(true);
    confirm.replaceWith(newConfirm);
    cancel.replaceWith(newCancel);
    closeBtn.replaceWith(newClose);

    newConfirm.addEventListener('click', () => { cleanup(); config.onConfirm?.(); });
    newCancel.addEventListener('click',  cleanup);
    newClose.addEventListener('click',   cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); }, { once: true });
  },
};

// ============================================================
// OVERVIEW VIEW — lightweight top-level summary
// ============================================================
const Overview = {
  render() {
    const main     = document.getElementById('app-main');
    const settings = Storage.getSettings();
    const invoices = Storage.getInvoices();
    const expenses = Storage.getExpenses();

    const totals = this._computeSummary(invoices, expenses, settings);

    main.innerHTML = `
      <div class="view-dashboard">
        <div class="view-header">
          <div>
            <h1>Dashboard</h1>
            <p class="subtitle">Your business at a glance</p>
          </div>
        </div>

        <!-- Summary Cards -->
        <div class="summary-cards">
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--accent-glow)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Invoiced</span>
              <span class="summary-value">${Utils.formatCurrency(totals.invoiced, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--info-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--info)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total ${Utils.escHtml(settings.taxLabel)}</span>
              <span class="summary-value">${Utils.formatCurrency(totals.tax, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--warning-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Outstanding</span>
              <span class="summary-value">${Utils.formatCurrency(totals.outstanding, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--danger-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Expenses</span>
              <span class="summary-value">${Utils.formatCurrency(totals.expenses, settings)}</span>
            </div>
          </div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-primary btn-lg" onclick="Router.navigate('editor/new')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Invoice
          </button>
          <button class="btn btn-ghost btn-lg" onclick="Router.navigate('expenses')">Add Expense</button>
          <button class="btn btn-ghost btn-lg" onclick="Router.navigate('invoices')">View All Invoices</button>
        </div>
      </div>
    `;
  },

  _computeSummary(invoices, expenses, settings) {
    const sum = (arr) => arr.reduce((s, inv) =>
      s + Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate ?? settings.defaultTaxRate).total, 0);
    const sumTax = (arr) => arr.reduce((s, inv) =>
      s + Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate ?? settings.defaultTaxRate).taxAmount, 0);

    return {
      invoiced:    sum(invoices),
      tax:         sumTax(invoices),
      outstanding: sum(invoices.filter(i => ['sent', 'draft'].includes(i.status))),
      expenses:    expenses.reduce((s, exp) => s + (parseFloat(exp.amount) || 0), 0),
    };
  },
};

// ============================================================
// DASHBOARD VIEW
// ============================================================
const Dashboard = {
  _currentFilter: 'all',
  _allInvoices:   [],

  render() {
    const main     = document.getElementById('app-main');
    const settings = Storage.getSettings();
    let invoices   = Storage.getInvoices();

    // Auto-flag overdue
    invoices = invoices.map(inv => {
      if (Utils.isOverdue(inv) && inv.status === 'sent') {
        inv.status = 'overdue';
        Storage.saveInvoice(inv);
      }
      return inv;
    });

    this._allInvoices   = invoices;
    this._currentFilter = 'all';

    const totals = this._computeSummary(invoices, settings);

    main.innerHTML = `
      <div class="view-dashboard">
        <div class="view-header">
          <div>
            <h1>Invoices</h1>
            <p class="subtitle">Manage and track all your client invoices</p>
          </div>
          <button class="btn btn-primary btn-lg" onclick="Router.navigate('editor/new')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Invoice
          </button>
        </div>

        <!-- Summary Cards -->
        <div class="summary-cards">
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--accent-glow)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Invoiced</span>
              <span class="summary-value">${Utils.formatCurrency(totals.total, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--info-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--info)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Tax</span>
              <span class="summary-value">${Utils.formatCurrency(totals.tax, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--success-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Paid</span>
              <span class="summary-value">${Utils.formatCurrency(totals.paid, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--warning-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Outstanding</span>
              <span class="summary-value">${Utils.formatCurrency(totals.outstanding, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--danger-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Overdue</span>
              <span class="summary-value">${Utils.formatCurrency(totals.overdue, settings)}</span>
            </div>
          </div>
        </div>

        <!-- Monthly performance charts -->
        <section class="analytics-section" aria-labelledby="analytics-heading">
          <div class="analytics-heading">
            <div>
              <h2 id="analytics-heading">Monthly performance</h2>
              <p>Invoice activity for ${new Date().getFullYear()}</p>
            </div>
          </div>
          <div class="analytics-grid">
            ${this._renderMonthlyChart('Total invoiced', 'invoice', invoices, settings)}
            ${this._renderMonthlyChart('Total overdue', 'overdue', invoices, settings)}
            ${this._renderMonthlyChart(`Total ${settings.taxLabel}`, 'tax', invoices, settings)}
          </div>
        </section>

        <!-- Controls -->
        <div class="invoice-controls">
          <div class="search-box">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-input" placeholder="Search by client or invoice number..." oninput="Dashboard.filter()" autocomplete="off" />
          </div>
          <div class="filter-tabs">
            <button class="filter-tab active" onclick="Dashboard.setFilter('all', this)">All <span style="opacity:.6;font-weight:400">${invoices.length}</span></button>
            <button class="filter-tab" onclick="Dashboard.setFilter('draft',   this)">Draft</button>
            <button class="filter-tab" onclick="Dashboard.setFilter('sent',    this)">Sent</button>
            <button class="filter-tab" onclick="Dashboard.setFilter('paid',    this)">Paid</button>
            <button class="filter-tab" onclick="Dashboard.setFilter('overdue', this)">Overdue</button>
          </div>
        </div>

        <!-- Invoice List -->
        <div id="invoice-list">
          ${this._renderInvoiceList(invoices, settings)}
        </div>
      </div>
    `;
  },

  _computeSummary(invoices, settings) {
    const sum = (arr) => arr.reduce((s, inv) =>
      s + Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate ?? settings.defaultTaxRate).total, 0);
    const sumTax = (arr) => arr.reduce((s, inv) =>
      s + Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate ?? settings.defaultTaxRate).taxAmount, 0);
    return {
      total:       sum(invoices),
      tax:         sumTax(invoices),
      paid:        sum(invoices.filter(i => i.status === 'paid')),
      outstanding: sum(invoices.filter(i => ['sent','draft'].includes(i.status))),
      overdue:     sum(invoices.filter(i => i.status === 'overdue')),
    };
  },

  _getMonthlyTotals(invoices, metric) {
    const totals = Array(12).fill(0);
    const currentYear = new Date().getFullYear();

    invoices.forEach(invoice => {
      if (!invoice.issueDate) return;
      const date = new Date(`${invoice.issueDate}T12:00:00`);
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== currentYear) return;

      const invoiceTotals = Utils.calculateTotals(invoice.items || [], invoice.discountType, invoice.discountValue, invoice.taxRate ?? Storage.getSettings().defaultTaxRate);
      const month = date.getMonth();
      if (metric === 'invoice') totals[month] += invoiceTotals.total;
      if (metric === 'overdue' && invoice.status === 'overdue') totals[month] += invoiceTotals.total;
      if (metric === 'tax') totals[month] += invoiceTotals.taxAmount;
    });

    return totals;
  },

  _renderMonthlyChart(title, metric, invoices, settings) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const values = this._getMonthlyTotals(invoices, metric);
    const maxValue = Math.max(...values, 0);
    const chartHeight = 148;
    const bars = values.map((value, index) => {
      const height = maxValue ? Math.max((value / maxValue) * chartHeight, value ? 4 : 0) : 0;
      const amount = Utils.escHtml(Utils.formatCurrency(value, settings));
      return `
        <div class="chart-column" title="${months[index]}: ${amount}">
          <span class="chart-tooltip">${amount}</span>
          <div class="chart-bar-track"><div class="chart-bar chart-bar-${metric}" style="height:${height}px"></div></div>
          <span class="chart-month">${months[index]}</span>
        </div>`;
    }).join('');

    return `
      <article class="chart-card">
        <div class="chart-card-header">
          <h3>${Utils.escHtml(title)}</h3>
          <span>${Utils.formatCurrency(values.reduce((sum, value) => sum + value, 0), settings)}</span>
        </div>
        <div class="chart-plot" role="img" aria-label="${Utils.escHtml(title)} by month for ${new Date().getFullYear()}">
          <div class="chart-gridlines"><span></span><span></span><span></span><span></span></div>
          <div class="chart-columns">${bars}</div>
        </div>
      </article>`;
  },

  _renderInvoiceList(invoices, settings) {
    if (!settings) settings = Storage.getSettings();

    if (!invoices.length) {
      return `
        <div class="invoice-table">
          <div class="empty-state">
            <div class="empty-icon">📄</div>
            <h3>No invoices found</h3>
            <p>Create your first invoice to get started</p>
            <button class="btn btn-primary" onclick="Router.navigate('editor/new')" style="margin-top:8px">
              Create Invoice
            </button>
          </div>
        </div>`;
    }

    const rows = invoices.map(inv => {
      const totals   = Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate ?? settings.defaultTaxRate);
      const clientCo = inv.clientCompany ? `<small>${Utils.escHtml(inv.clientCompany)}</small>` : '';
      return `
        <div class="invoice-row" onclick="Router.navigate('preview/${inv.id}')">
          <span class="invoice-number">${Utils.escHtml(inv.invoiceNumber)}</span>
          <span class="client-name">
            <strong>${Utils.escHtml(inv.clientName) || '—'}</strong>
            ${clientCo}
          </span>
          <span>${Utils.formatDate(inv.issueDate)}</span>
          <span>${Utils.formatDate(inv.dueDate)}</span>
          <span class="invoice-amount" style="font-size:14px;">
            ${inv.taxRate ?? settings.defaultTaxRate ?? 0}% <span style="font-size:12px; opacity:0.6;">(${Utils.formatCurrency(totals.taxAmount, settings)})</span>
          </span>
          <span class="invoice-amount">${Utils.formatCurrency(totals.total, settings)}</span>
          <span><span class="status-badge status-${inv.status}">${inv.status}</span></span>
          <span class="row-actions" onclick="event.stopPropagation()">
            <button class="icon-btn" title="Edit" onclick="Router.navigate('editor/${inv.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" title="Duplicate" onclick="Dashboard.duplicate('${inv.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="icon-btn icon-btn-danger" title="Delete" onclick="Dashboard.confirmDelete('${inv.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </span>
        </div>`;
    }).join('');

    return `
      <div class="invoice-table">
        <div class="invoice-table-header">
          <span>Invoice #</span>
          <span>Client</span>
          <span>Issue Date</span>
          <span>Due Date</span>
          <span>Tax</span>
          <span>Amount</span>
          <span>Status</span>
          <span></span>
        </div>
        ${rows}
      </div>`;
  },

  setFilter(filter, btn) {
    this._currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    this.filter();
  },

  filter() {
    const query    = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
    const settings = Storage.getSettings();
    let filtered   = this._allInvoices;

    if (this._currentFilter !== 'all') {
      filtered = filtered.filter(inv => inv.status === this._currentFilter);
    }
    if (query) {
      filtered = filtered.filter(inv =>
        inv.invoiceNumber?.toLowerCase().includes(query) ||
        inv.clientName?.toLowerCase().includes(query)    ||
        inv.clientCompany?.toLowerCase().includes(query) ||
        inv.projectName?.toLowerCase().includes(query)
      );
    }

    const el = document.getElementById('invoice-list');
    if (el) el.innerHTML = this._renderInvoiceList(filtered, settings);
  },

  duplicate(id) {
    const inv = Storage.getInvoice(id);
    if (!inv) return;
    const settings  = Storage.getSettings();
    const newInv    = {
      ...JSON.parse(JSON.stringify(inv)),
      id:            Utils.generateId(),
      invoiceNumber: Utils.generateInvoiceNumber(settings),
      status:        'draft',
      issueDate:     Utils.today(),
      dueDate:       Utils.addDays(Utils.today(), 30),
      createdAt:     new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
    };
    settings.nextInvoiceNumber++;
    Storage.saveSettings(settings);
    Storage.saveInvoice(newInv);
    Toast.show('Invoice duplicated successfully');
    this.render();
  },

  confirmDelete(id) {
    const inv = Storage.getInvoice(id);
    Modal.show({
      title:        'Delete Invoice',
      body:         `<p>Are you sure you want to delete invoice <strong>${Utils.escHtml(inv?.invoiceNumber)}</strong>?<br>This action cannot be undone.</p>`,
      confirmText:  'Delete Invoice',
      confirmClass: 'danger',
      onConfirm:    () => {
        Storage.deleteInvoice(id);
        Toast.show('Invoice deleted', 'info');
        this.render();
      },
    });
  },
};

// ============================================================
// EXPENSES VIEW
// ============================================================
const Expenses = {
  _all:            [],
  _currentFilter:  'all',

  render() {
    const main      = document.getElementById('app-main');
    const settings  = Storage.getSettings();
    const expenses  = Storage.getExpenses();

    this._all           = expenses;
    this._currentFilter = 'all';

    const totals = this._computeSummary(expenses);

    main.innerHTML = `
      <div class="view-dashboard">
        <div class="view-header">
          <div>
            <h1>Expenses</h1>
            <p class="subtitle">Track what the brand spends on creative work</p>
          </div>
          <button class="btn btn-primary btn-lg" onclick="Expenses.openForm()">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Expense
          </button>
        </div>

        <!-- Summary Cards -->
        <div class="summary-cards">
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--warning-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">This Month</span>
              <span class="summary-value">${Utils.formatCurrency(totals.thisMonth, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--danger-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">This Year</span>
              <span class="summary-value">${Utils.formatCurrency(totals.thisYear, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--info-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--info)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">All Time</span>
              <span class="summary-value">${Utils.formatCurrency(totals.allTime, settings)}</span>
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-icon" style="background:var(--success-bg)">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </div>
            <div class="summary-info">
              <span class="summary-label">Total Entries</span>
              <span class="summary-value">${expenses.length}</span>
            </div>
          </div>
        </div>

        <!-- Monthly chart -->
        <section class="analytics-section" aria-labelledby="expense-analytics-heading">
          <div class="analytics-heading">
            <div>
              <h2 id="expense-analytics-heading">Monthly spend</h2>
              <p>Expense activity for ${new Date().getFullYear()}</p>
            </div>
          </div>
          <div class="analytics-grid" style="grid-template-columns:1fr">
            ${this._renderMonthlyChart(expenses, settings)}
          </div>
        </section>

        <!-- Controls -->
        <div class="invoice-controls">
          <div class="search-box">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="expense-search-input" placeholder="Search by description or vendor..." oninput="Expenses.filter()" autocomplete="off" />
          </div>
          <div class="filter-tabs">
            <button class="filter-tab active" onclick="Expenses.setFilter('all', this)">All <span style="opacity:.6;font-weight:400">${expenses.length}</span></button>
            ${EXPENSE_CATEGORIES.map(cat => `<button class="filter-tab" onclick="Expenses.setFilter('${Utils.escHtml(cat)}', this)">${Utils.escHtml(cat)}</button>`).join('')}
          </div>
        </div>

        <!-- Expense List -->
        <div id="expense-list">
          ${this._renderExpenseList(expenses, settings)}
        </div>
      </div>
    `;
  },

  _computeSummary(expenses) {
    const now = new Date();
    const month = now.getMonth();
    const year  = now.getFullYear();

    const parsed = expenses.map(e => ({ ...e, _date: e.date ? new Date(`${e.date}T12:00:00`) : null }));

    const sum = (arr) => arr.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    return {
      thisMonth: sum(parsed.filter(e => e._date && e._date.getMonth() === month && e._date.getFullYear() === year)),
      thisYear:  sum(parsed.filter(e => e._date && e._date.getFullYear() === year)),
      allTime:   sum(parsed),
    };
  },

  _getMonthlyTotals(expenses) {
    const totals = Array(12).fill(0);
    const currentYear = new Date().getFullYear();

    expenses.forEach(expense => {
      if (!expense.date) return;
      const date = new Date(`${expense.date}T12:00:00`);
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== currentYear) return;
      totals[date.getMonth()] += parseFloat(expense.amount) || 0;
    });

    return totals;
  },

  _renderMonthlyChart(expenses, settings) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const values = this._getMonthlyTotals(expenses);
    const maxValue = Math.max(...values, 0);
    const chartHeight = 148;
    const bars = values.map((value, index) => {
      const height = maxValue ? Math.max((value / maxValue) * chartHeight, value ? 4 : 0) : 0;
      const amount = Utils.escHtml(Utils.formatCurrency(value, settings));
      return `
        <div class="chart-column" title="${months[index]}: ${amount}">
          <span class="chart-tooltip">${amount}</span>
          <div class="chart-bar-track"><div class="chart-bar chart-bar-expense" style="height:${height}px"></div></div>
          <span class="chart-month">${months[index]}</span>
        </div>`;
    }).join('');

    return `
      <article class="chart-card">
        <div class="chart-card-header">
          <h3>Total spent</h3>
          <span>${Utils.formatCurrency(values.reduce((sum, value) => sum + value, 0), settings)}</span>
        </div>
        <div class="chart-plot" role="img" aria-label="Monthly spend for ${new Date().getFullYear()}">
          <div class="chart-gridlines"><span></span><span></span><span></span><span></span></div>
          <div class="chart-columns">${bars}</div>
        </div>
      </article>`;
  },

  _renderExpenseList(expenses, settings) {
    if (!settings) settings = Storage.getSettings();

    if (!expenses.length) {
      return `
        <div class="invoice-table">
          <div class="empty-state">
            <div class="empty-icon">💸</div>
            <h3>No expenses logged yet</h3>
            <p>Add your first expense to start tracking spend</p>
            <button class="btn btn-primary" onclick="Expenses.openForm()" style="margin-top:8px">
              Add Expense
            </button>
          </div>
        </div>`;
    }

    const sorted = [...expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const rows = sorted.map(exp => {
      const vendor = exp.vendor ? `<small>${Utils.escHtml(exp.vendor)}</small>` : '';
      return `
        <div class="expense-row" onclick="Expenses.openForm('${exp.id}')">
          <span>${Utils.formatDate(exp.date)}</span>
          <span class="client-name">
            <strong>${Utils.escHtml(exp.description) || '—'}</strong>
            ${vendor}
          </span>
          <span><span class="category-badge">${Utils.escHtml(exp.category || 'Other')}</span></span>
          <span class="invoice-amount">${Utils.formatCurrency(exp.amount, settings)}</span>
          <span class="row-actions" onclick="event.stopPropagation()">
            <button class="icon-btn" title="Edit" onclick="Expenses.openForm('${exp.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn icon-btn-danger" title="Delete" onclick="Expenses.confirmDelete('${exp.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </span>
        </div>`;
    }).join('');

    return `
      <div class="invoice-table">
        <div class="expense-table-header">
          <span>Date</span>
          <span>Description</span>
          <span>Category</span>
          <span>Amount</span>
          <span></span>
        </div>
        ${rows}
      </div>`;
  },

  setFilter(filter, btn) {
    this._currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    this.filter();
  },

  filter() {
    const query    = (document.getElementById('expense-search-input')?.value || '').toLowerCase().trim();
    const settings = Storage.getSettings();
    let filtered   = this._all;

    if (this._currentFilter !== 'all') {
      filtered = filtered.filter(exp => exp.category === this._currentFilter);
    }
    if (query) {
      filtered = filtered.filter(exp =>
        exp.description?.toLowerCase().includes(query) ||
        exp.vendor?.toLowerCase().includes(query)
      );
    }

    const el = document.getElementById('expense-list');
    if (el) el.innerHTML = this._renderExpenseList(filtered, settings);
  },

  openForm(id) {
    const isEdit   = Boolean(id);
    const existing = isEdit ? Storage.getExpense(id) : null;
    const expense  = existing || {
      id:          Utils.generateId(),
      date:        Utils.today(),
      category:    EXPENSE_CATEGORIES[0],
      description: '',
      vendor:      '',
      amount:      0,
      notes:       '',
    };
    const settings = Storage.getSettings();

    const overlay   = document.getElementById('modal-overlay');
    const title     = document.getElementById('modal-title');
    const body      = document.getElementById('modal-body');
    const confirm   = document.getElementById('modal-confirm');
    const cancel    = document.getElementById('modal-cancel');
    const closeBtn  = document.getElementById('modal-close');

    title.textContent = isEdit ? 'Edit Expense' : 'Add Expense';
    body.innerHTML = `
      <div class="form-grid">
        <div class="form-group">
          <label>Date *</label>
          <input type="date" id="exp-date" value="${expense.date || Utils.today()}" />
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="exp-category">
            ${EXPENSE_CATEGORIES.map(cat => `<option value="${Utils.escHtml(cat)}" ${expense.category === cat ? 'selected' : ''}>${Utils.escHtml(cat)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group form-full">
          <label>What was this for? *</label>
          <input type="text" id="exp-description" placeholder="e.g. Drone hire for Untold Voices shoot" value="${Utils.escHtml(expense.description || '')}" />
        </div>
        <div class="form-group">
          <label>Paid to / Vendor</label>
          <input type="text" id="exp-vendor" placeholder="e.g. ABC Rentals" value="${Utils.escHtml(expense.vendor || '')}" />
        </div>
        <div class="form-group">
          <label>Amount *</label>
          <div class="input-with-prefix">
            <span>${settings.currencySymbol}</span>
            <input type="number" id="exp-amount" min="0" step="0.01" value="${expense.amount || 0}" />
          </div>
        </div>
        <div class="form-group form-full">
          <label>Notes</label>
          <textarea id="exp-notes" rows="3" placeholder="Optional context...">${Utils.escHtml(expense.notes || '')}</textarea>
        </div>
      </div>`;
    confirm.textContent = isEdit ? 'Save Changes' : 'Add Expense';
    confirm.className    = 'btn btn-primary';
    cancel.textContent   = 'Cancel';

    overlay.classList.add('visible');
    const cleanup = () => overlay.classList.remove('visible');

    // Clone to remove old listeners (same pattern as Modal.show)
    const newConfirm = confirm.cloneNode(true);
    const newCancel  = cancel.cloneNode(true);
    const newClose   = closeBtn.cloneNode(true);
    confirm.replaceWith(newConfirm);
    cancel.replaceWith(newCancel);
    closeBtn.replaceWith(newClose);

    newConfirm.addEventListener('click', () => {
      const date        = document.getElementById('exp-date').value || Utils.today();
      const description = document.getElementById('exp-description').value.trim();
      const amount       = parseFloat(document.getElementById('exp-amount').value) || 0;

      if (!description) {
        Toast.show('Please describe what this expense was for', 'error');
        document.getElementById('exp-description')?.focus();
        return;
      }
      if (!amount || amount <= 0) {
        Toast.show('Please enter a valid amount', 'error');
        document.getElementById('exp-amount')?.focus();
        return;
      }

      const record = {
        ...expense,
        date,
        description,
        category:  document.getElementById('exp-category').value,
        vendor:    document.getElementById('exp-vendor').value.trim(),
        amount,
        notes:     document.getElementById('exp-notes').value.trim(),
        createdAt: expense.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      Storage.saveExpense(record);
      cleanup();
      Toast.show(isEdit ? 'Expense updated' : 'Expense added');
      Expenses.render();
    });
    newCancel.addEventListener('click', cleanup);
    newClose.addEventListener('click',  cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); }, { once: true });
  },

  confirmDelete(id) {
    const exp = Storage.getExpense(id);
    Modal.show({
      title:        'Delete Expense',
      body:         `<p>Are you sure you want to delete <strong>${Utils.escHtml(exp?.description)}</strong>?<br>This action cannot be undone.</p>`,
      confirmText:  'Delete Expense',
      confirmClass: 'danger',
      onConfirm:    () => {
        Storage.deleteExpense(id);
        Toast.show('Expense deleted', 'info');
        this.render();
      },
    });
  },
};

// ============================================================
// EDITOR VIEW
// ============================================================
const Editor = {
  _invoice: null,
  _isNew:   false,

  render(id) {
    const settings = Storage.getSettings();
    this._isNew    = !id || id === 'new';

    if (this._isNew) {
      this._invoice = {
        id:            Utils.generateId(),
        invoiceNumber: Utils.generateInvoiceNumber(settings),
        status:        'draft',
        clientName:    '',
        clientCompany: '',
        clientEmail:   '',
        clientAddress: '',
        projectName:   '',
        issueDate:     Utils.today(),
        dueDate:       Utils.addDays(Utils.today(), 30),
        items:         [this._newItem(settings)],
        discountType:  'percentage',
        discountValue: 0,
        taxRate:       settings.defaultTaxRate || 0,
        notes:         `${settings.defaultPaymentTerms}\n\n${settings.bankDetails}`,
        createdAt:     new Date().toISOString(),
        updatedAt:     new Date().toISOString(),
      };
    } else {
      this._invoice = Storage.getInvoice(id);
      if (!this._invoice) { Router.navigate('invoices'); return; }
      this._invoice.taxRate = this._invoice.taxRate ?? settings.defaultTaxRate ?? 0;
    }

    document.getElementById('app-main').innerHTML = this._buildHTML(settings);
  },

  _buildHTML(settings) {
    const inv = this._invoice;
    return `
      <div class="view-editor">
        <div class="view-header">
          <div style="display:flex;align-items:center;gap:14px">
            <button class="btn btn-ghost" onclick="Router.back()">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <div>
              <h1>${this._isNew ? 'New Invoice' : 'Edit Invoice'}</h1>
              <p class="subtitle">${Utils.escHtml(inv.invoiceNumber)}</p>
            </div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-ghost" onclick="Editor.save('draft', true)">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Save Draft
            </button>
            <button class="btn btn-primary" onclick="Editor.saveAndPreview()">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Preview Invoice
            </button>
          </div>
        </div>

        <div class="editor-layout">
          <div class="editor-main">

            <!-- Client -->
            <div class="editor-section">
              <h2 class="section-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Client Details
              </h2>
              <div class="form-grid">
                <div class="form-group">
                  <label>Client Name *</label>
                  <input type="text" id="f-clientName" placeholder="John Smith" value="${Utils.escHtml(inv.clientName)}" oninput="Editor._set('clientName',this.value)" autocomplete="name" />
                </div>
                <div class="form-group">
                  <label>Company / Organisation</label>
                  <input type="text" id="f-clientCompany" placeholder="Acme Corp" value="${Utils.escHtml(inv.clientCompany)}" oninput="Editor._set('clientCompany',this.value)" />
                </div>
                <div class="form-group">
                  <label>Email Address</label>
                  <input type="email" id="f-clientEmail" placeholder="john@acmecorp.com" value="${Utils.escHtml(inv.clientEmail)}" oninput="Editor._set('clientEmail',this.value)" />
                </div>
                <div class="form-group">
                  <label>Project Name</label>
                  <input type="text" id="f-projectName" placeholder="Brand Identity Project" value="${Utils.escHtml(inv.projectName)}" oninput="Editor._set('projectName',this.value)" />
                </div>
                <div class="form-group form-full">
                  <label>Billing Address</label>
                  <textarea id="f-clientAddress" rows="3" placeholder="123 Client Street&#10;London, UK" oninput="Editor._set('clientAddress',this.value)">${Utils.escHtml(inv.clientAddress)}</textarea>
                </div>
              </div>
            </div>

            <!-- Invoice Details -->
            <div class="editor-section">
              <h2 class="section-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                Invoice Details
              </h2>
              <div class="form-grid">
                <div class="form-group">
                  <label>Invoice Number</label>
                  <input type="text" id="f-invoiceNumber" value="${Utils.escHtml(inv.invoiceNumber)}" oninput="Editor._set('invoiceNumber',this.value)" />
                </div>
                <div class="form-group">
                  <label>Status</label>
                  <select id="f-status" onchange="Editor._set('status',this.value)">
                    <option value="draft"   ${inv.status==='draft'   ?'selected':''}>Draft</option>
                    <option value="sent"    ${inv.status==='sent'    ?'selected':''}>Sent</option>
                    <option value="paid"    ${inv.status==='paid'    ?'selected':''}>Paid</option>
                    <option value="overdue" ${inv.status==='overdue' ?'selected':''}>Overdue</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Issue Date</label>
                  <input type="date" id="f-issueDate" value="${inv.issueDate || ''}" onchange="Editor._set('issueDate',this.value)" />
                </div>
                <div class="form-group">
                  <label>Due Date</label>
                  <input type="date" id="f-dueDate" value="${inv.dueDate || ''}" onchange="Editor._set('dueDate',this.value)" />
                </div>
                <div class="form-group">
                  <label>${Utils.escHtml(settings.taxLabel)} Rate (applied to subtotal)</label>
                  <input type="number" id="f-taxRate" min="0" max="100" step="0.5" value="${inv.taxRate ?? 0}" oninput="Editor._set('taxRate',parseFloat(this.value)||0); Editor._refreshTotals()" />
                </div>
              </div>
            </div>

            <!-- Line Items -->
            <div class="editor-section">
              <h2 class="section-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                Deliverables & Line Items
              </h2>
              <div class="items-table">
                <div class="items-header">
                  <span>Description / Deliverable</span>
                  <span style="text-align:center">Qty</span>
                  <span>Unit Price</span>
                  <span style="text-align:right">Line Total</span>
                  <span></span>
                </div>
                <div id="items-container">
                  ${inv.items.map((item, idx) => this._renderItemRow(item, idx, settings)).join('')}
                </div>
              </div>
              <button class="btn btn-add-item" onclick="Editor.addItem()">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Line Item
              </button>
            </div>

            <!-- Notes -->
            <div class="editor-section">
              <h2 class="section-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                Notes & Payment Information
              </h2>
              <div class="form-group">
                <label>Payment terms, bank details, or any notes for the client</label>
                <textarea id="f-notes" rows="6" placeholder="Payment due within 30 days..." oninput="Editor._set('notes',this.value)">${Utils.escHtml(inv.notes)}</textarea>
              </div>
            </div>

          </div><!-- /editor-main -->

          <!-- Sidebar: Totals -->
          <div class="editor-sidebar">
            <div class="totals-card" id="totals-card">
              ${this._renderTotals(settings)}
            </div>
          </div>
        </div>
      </div>`;
  },

  _renderItemRow(item, idx, settings) {
    if (!settings) settings = Storage.getSettings();
    const lineTotal = parseFloat(item.quantity || 0) * parseFloat(item.unitPrice || 0);
    const canRemove = this._invoice.items.length > 1;
    return `
      <div class="item-row" data-idx="${idx}">
        <div class="item-description">
          <input type="text" placeholder="e.g. Logo Design, Social Media Content..." value="${Utils.escHtml(item.description || '')}"
            oninput="Editor.updateItem(${idx},'description',this.value)" />
        </div>
        <div class="item-qty">
          <input type="number" min="0" step="0.5" value="${item.quantity}"
            oninput="Editor.updateItem(${idx},'quantity',this.value)" />
        </div>
        <div class="item-price">
          <div class="input-with-prefix">
            <span>${settings.currencySymbol}</span>
            <input type="number" min="0" step="0.01" value="${item.unitPrice}"
              oninput="Editor.updateItem(${idx},'unitPrice',this.value)" />
          </div>
        </div>
        <div class="item-total">
          <span id="line-total-${idx}">${Utils.formatCurrency(lineTotal, settings)}</span>
        </div>
        <div class="item-actions">
          <button class="icon-btn icon-btn-danger" onclick="Editor.removeItem(${idx})" ${canRemove ? '' : 'disabled'} title="Remove">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>`;
  },

  _renderTotals(settings) {
    if (!settings) settings = Storage.getSettings();
    const inv    = this._invoice;
    const totals = Utils.calculateTotals(inv.items || [], inv.discountType, inv.discountValue, inv.taxRate);
    const taxLabel = `${settings.taxLabel} (${inv.taxRate || 0}%)`;
    return `
      <h3>Invoice Summary</h3>
      <div class="totals-rows">
        <div class="totals-row">
          <span>Subtotal</span>
          <span>${Utils.formatCurrency(totals.subtotal, settings)}</span>
        </div>
        <div class="totals-row">
          <span>${Utils.escHtml(taxLabel)}</span>
          <span>${Utils.formatCurrency(totals.taxAmount, settings)}</span>
        </div>

        <!-- Discount -->
        <div class="totals-row discount-row">
          <div class="discount-control">
            <span>Discount</span>
            <div class="discount-type-toggle">
              <button class="${inv.discountType==='percentage'?'active':''}" onclick="Editor.setDiscountType('percentage')">%</button>
              <button class="${inv.discountType==='fixed'?'active':''}" onclick="Editor.setDiscountType('fixed')">${settings.currencySymbol}</button>
            </div>
            <input type="number" min="0" step="${inv.discountType==='percentage'?'0.5':'0.01'}"
              value="${inv.discountValue || 0}"
              oninput="Editor._set('discountValue', parseFloat(this.value)||0); Editor._refreshTotals()"
              style="width:80px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-primary);font-size:13px;outline:none" />
          </div>
          <span>-${Utils.formatCurrency(totals.discountAmount, settings)}</span>
        </div>

        <div class="totals-divider"></div>
        <div class="totals-total">
          <span>TOTAL ${settings.currency}</span>
          <span>${Utils.formatCurrency(totals.total, settings)}</span>
        </div>
      </div>

      <div style="margin-top:20px;display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="Editor.saveAndPreview()">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Preview Invoice
        </button>
        <button class="btn btn-ghost" style="width:100%;justify-content:center" onclick="Editor.save('draft',true)">Save Draft</button>
      </div>`;
  },

  _newItem(settings) {
    if (!settings) settings = Storage.getSettings();
    return { id: Utils.generateId(), description: '', quantity: 1, unitPrice: 0 };
  },

  _set(field, value) {
    if (this._invoice) {
      this._invoice[field] = value;
      this._invoice.updatedAt = new Date().toISOString();
    }
  },

  updateItem(idx, field, value) {
    const item    = this._invoice.items[idx];
    if (!item) return;
    item[field]   = field === 'description' ? value : (parseFloat(value) || 0);
    this._invoice.updatedAt = new Date().toISOString();

    // Update live line total
    const lineTotal = item.quantity * item.unitPrice;
    const settings  = Storage.getSettings();
    const el        = document.getElementById(`line-total-${idx}`);
    if (el) el.textContent = Utils.formatCurrency(lineTotal, settings);

    this._refreshTotals();
  },

  addItem() {
    const settings = Storage.getSettings();
    const item     = this._newItem(settings);
    this._invoice.items.push(item);
    const container = document.getElementById('items-container');
    if (container) {
      const idx = this._invoice.items.length - 1;
      container.insertAdjacentHTML('beforeend', this._renderItemRow(item, idx, settings));
    }
    this._refreshTotals();
  },

  removeItem(idx) {
    if (this._invoice.items.length <= 1) return;
    this._invoice.items.splice(idx, 1);
    const settings  = Storage.getSettings();
    const container = document.getElementById('items-container');
    if (container) {
      container.innerHTML = this._invoice.items.map((item, i) => this._renderItemRow(item, i, settings)).join('');
    }
    this._refreshTotals();
  },

  setDiscountType(type) {
    this._invoice.discountType  = type;
    this._invoice.discountValue = 0;
    this._refreshTotals();
  },

  _refreshTotals() {
    const card = document.getElementById('totals-card');
    if (card) card.innerHTML = this._renderTotals();
  },

  _validate() {
    if (!this._invoice.clientName?.trim()) {
      Toast.show('Please enter a client name', 'error');
      document.getElementById('f-clientName')?.focus();
      return false;
    }
    const hasDescription = this._invoice.items.some(i => i.description?.trim());
    if (!hasDescription) {
      Toast.show('Please add at least one deliverable with a description', 'error');
      return false;
    }
    return true;
  },

  save(status, showToast) {
    if (status) this._invoice.status = status;
    this._invoice.updatedAt = new Date().toISOString();

    if (this._isNew) {
      const settings = Storage.getSettings();
      settings.nextInvoiceNumber++;
      Storage.saveSettings(settings);
      this._isNew = false;
    }

    Storage.saveInvoice(this._invoice);
    if (showToast) Toast.show('Invoice saved');
    return true;
  },

  saveAndPreview() {
    if (!this._validate()) return;
    this.save(null, false);
    Router.navigate(`preview/${this._invoice.id}`);
  },
};

// ============================================================
// PREVIEW VIEW
// ============================================================
const Preview = {
  _invoice: null,

  render(id) {
    this._invoice = Storage.getInvoice(id);
    if (!this._invoice) { Router.navigate('invoices'); return; }

    const settings = Storage.getSettings();
    const totals   = Utils.calculateTotals(
      this._invoice.items || [], this._invoice.discountType, this._invoice.discountValue,
      this._invoice.taxRate ?? settings.defaultTaxRate
    );

    document.getElementById('app-main').innerHTML = `
      <div class="view-preview">
        <!-- Toolbar -->
        <div class="preview-toolbar no-print">
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-ghost" onclick="Router.back()">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <span class="status-badge status-${this._invoice.status}">${this._invoice.status}</span>
            <span style="color:var(--text-muted);font-size:14px">${Utils.escHtml(this._invoice.invoiceNumber)}</span>
          </div>
          <div class="preview-actions">
            <select class="status-select" onchange="Preview.updateStatus(this.value)">
              <option value="" disabled selected>Change status...</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="paid">✓ Mark as Paid</option>
              <option value="overdue">Overdue</option>
            </select>
            <button class="btn btn-ghost" onclick="Router.navigate('editor/${this._invoice.id}')">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="btn btn-primary" onclick="Preview.printInvoice()">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Export PDF
            </button>
          </div>
        </div>

        <!-- Invoice Paper -->
        <div class="invoice-paper">
          ${this._renderTemplate(this._invoice, settings, totals)}
        </div>
      </div>`;
  },

  _renderTemplate(invoice, settings, totals) {
    const accent = settings.accentColor || '#7c3aed';
    const gold   = settings.accentColorSecondary || '#f59e0b';

    const logoHtml = settings.logoUrl
      ? `<img src="${settings.logoUrl}" alt="${Utils.escHtml(settings.agencyName)}" class="inv-logo" />`
      : `<div class="inv-logo-text" style="background:linear-gradient(135deg,${accent},${gold})">${settings.agencyName.slice(0,2).toUpperCase()}</div>`;

    const statusStyles = {
      draft:   { bg:'#f1f5f9', color:'#64748b' },
      sent:    { bg:'#dbeafe', color:'#1d4ed8' },
      paid:    { bg:'#dcfce7', color:'#16a34a' },
      overdue: { bg:'#fee2e2', color:'#dc2626' },
    };
    const ss = statusStyles[invoice.status] || statusStyles.draft;

    const itemRows = (invoice.items || []).map((item, i) => {
      const lineTotal = parseFloat(item.quantity || 0) * parseFloat(item.unitPrice || 0);
      return `
        <tr class="inv-tr${i%2===1?' inv-tr-alt':''}">
          <td class="inv-td inv-td-desc">${Utils.escHtml(item.description) || '—'}</td>
          <td class="inv-td inv-td-num">${item.quantity}</td>
          <td class="inv-td inv-td-num">${Utils.formatCurrency(item.unitPrice, settings)}</td>
          <td class="inv-td inv-td-num" style="font-weight:700">${Utils.formatCurrency(lineTotal, settings)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="invoice-doc invoice-doc-dark" style="--inv-accent:${accent};--inv-gold:${gold}">
        <!-- Original abstract banner artwork -->
        <div class="inv-header">
          <img src="/assets/invoice-wave.png" alt="" class="inv-artwork" onerror="this.remove();this.parentElement.classList.add('inv-header-fallback')" />
        </div>

        <div class="inv-title-row">
          <div class="inv-title-brand">
            ${logoHtml}
            <div class="inv-brand-info">
              <span class="inv-agency-name">${Utils.escHtml(settings.agencyName)}</span>
              ${settings.agencyTagline ? `<span class="inv-agency-tagline">${Utils.escHtml(settings.agencyTagline)}</span>` : ''}
            </div>
          </div>
          <div class="inv-title-block">
            <div class="inv-number">${Utils.escHtml(invoice.invoiceNumber)}</div>
            <div class="inv-status-badge" style="background:${ss.bg};color:${ss.color}">${invoice.status.toUpperCase()}</div>
          </div>
          <div class="inv-title">INVOICE</div>
        </div>

        <!-- Bill To / From / Dates -->
        <div class="inv-info-row">
          <div class="inv-info-block">
            <div class="inv-info-label">From</div>
            <div class="inv-info-name">${Utils.escHtml(settings.agencyName)}</div>
            ${settings.agencyAddress ? `<div class="inv-info-detail" style="white-space:pre-line;margin-top:4px">${Utils.escHtml(settings.agencyAddress)}</div>` : ''}
            ${settings.agencyEmail   ? `<div class="inv-info-detail">${Utils.escHtml(settings.agencyEmail)}</div>` : ''}
            ${settings.agencyPhone   ? `<div class="inv-info-detail">${Utils.escHtml(settings.agencyPhone)}</div>` : ''}
            ${settings.agencyWebsite ? `<div class="inv-info-detail">${Utils.escHtml(settings.agencyWebsite)}</div>` : ''}
          </div>
          <div class="inv-info-block">
            <div class="inv-info-label">Bill To</div>
            <div class="inv-info-name">${Utils.escHtml(invoice.clientName) || '—'}</div>
            ${invoice.clientCompany ? `<div class="inv-info-company">${Utils.escHtml(invoice.clientCompany)}</div>` : ''}
            ${invoice.clientEmail   ? `<div class="inv-info-detail">${Utils.escHtml(invoice.clientEmail)}</div>` : ''}
            ${invoice.clientAddress ? `<div class="inv-info-detail" style="white-space:pre-line;margin-top:4px">${Utils.escHtml(invoice.clientAddress)}</div>` : ''}
          </div>
          <div class="inv-dates-block">
            ${invoice.projectName ? `
              <div class="inv-date-row">
                <span class="inv-date-label">Project</span>
                <span class="inv-date-value">${Utils.escHtml(invoice.projectName)}</span>
              </div>` : ''}
            <div class="inv-date-row">
              <span class="inv-date-label">Issue Date</span>
              <span class="inv-date-value">${Utils.formatDate(invoice.issueDate)}</span>
            </div>
            <div class="inv-date-row">
              <span class="inv-date-label">Due Date</span>
              <span class="inv-date-value" style="${invoice.status==='overdue'?'color:#dc2626;font-weight:700':''}">
                ${Utils.formatDate(invoice.dueDate)}
              </span>
            </div>
          </div>
        </div>

        <!-- Items Table -->
        <table class="inv-table">
          <thead>
            <tr>
              <th class="inv-th inv-th-desc">Description</th>
              <th class="inv-th inv-th-num">Qty</th>
              <th class="inv-th inv-th-num">Unit Price</th>
              <th class="inv-th inv-th-num">Amount</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <div class="inv-settlement">
          <!-- Payment details / notes -->
          ${invoice.notes ? `
          <div class="inv-notes">
            <div class="inv-notes-label">Payment Details & Notes</div>
            <div class="inv-notes-content" style="white-space:pre-line">${Utils.escHtml(invoice.notes)}</div>
          </div>` : '<div></div>'}

          <!-- Totals -->
          <div class="inv-totals-container">
            <div class="inv-totals">
            <div class="inv-totals-row">
              <span>Subtotal</span>
              <span>${Utils.formatCurrency(totals.subtotal, settings)}</span>
            </div>
            ${totals.taxAmount > 0 ? `
            <div class="inv-totals-row">
              <span>${Utils.escHtml(settings.taxLabel)} (${invoice.taxRate ?? settings.defaultTaxRate ?? 0}%)</span>
              <span>${Utils.formatCurrency(totals.taxAmount, settings)}</span>
            </div>` : ''}
            ${totals.discountAmount > 0 ? `
            <div class="inv-totals-row" style="color:#dc2626">
              <span>Discount</span>
              <span>-${Utils.formatCurrency(totals.discountAmount, settings)}</span>
            </div>` : ''}
            <div class="inv-totals-divider"></div>
            <div class="inv-totals-total">
              <span>TOTAL ${settings.currency}</span>
              <span>${Utils.formatCurrency(totals.total, settings)}</span>
            </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="inv-footer">
          <div class="inv-footer-left">Thank you for your business!</div>
          <div class="inv-footer-right">${Utils.escHtml(settings.agencyWebsite || settings.agencyEmail || '')}</div>
        </div>
      </div>`;
  },

  updateStatus(status) {
    if (!status || !this._invoice) return;
    this._invoice.status = status;
    this._invoice.updatedAt = new Date().toISOString();
    Storage.saveInvoice(this._invoice);
    Toast.show(`Status updated to "${status}"`);
    this.render(this._invoice.id);
  },

  printInvoice() {
    window.print();
  },
};

// ============================================================
// SETTINGS VIEW
// ============================================================
const Settings = {
  render() {
    const settings = Storage.getSettings();
    const currencies = [
      ['GBP','£','GBP (£ — British Pound)'],
      ['USD','$','USD ($ — US Dollar)'],
      ['EUR','€','EUR (€ — Euro)'],
      ['NGN','₦','NGN (₦ — Nigerian Naira)'],
      ['CAD','CA$','CAD (CA$ — Canadian Dollar)'],
      ['AUD','A$','AUD (A$ — Australian Dollar)'],
      ['ZAR','R','ZAR (R — South African Rand)'],
      ['GHS','₵','GHS (₵ — Ghanaian Cedi)'],
      ['KES','KSh','KES (KSh — Kenyan Shilling)'],
    ];

    document.getElementById('app-main').innerHTML = `
      <div class="view-settings">
        <div class="view-header">
          <div>
            <h1>Settings</h1>
            <p class="subtitle">Configure your agency branding and invoice defaults</p>
          </div>
          <button class="btn btn-primary" onclick="Settings.save()">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save Changes
          </button>
        </div>

        <div class="settings-grid">

          <!-- Agency Info -->
          <div class="editor-section">
            <h2 class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              Agency Information
            </h2>
            <div class="form-grid">
              <div class="form-group">
                <label>Agency / Brand Name</label>
                <input type="text" id="s-agencyName" value="${Utils.escHtml(settings.agencyName)}" />
              </div>
              <div class="form-group">
                <label>Tagline</label>
                <input type="text" id="s-agencyTagline" value="${Utils.escHtml(settings.agencyTagline)}" />
              </div>
              <div class="form-group">
                <label>Email</label>
                <input type="email" id="s-agencyEmail" value="${Utils.escHtml(settings.agencyEmail)}" />
              </div>
              <div class="form-group">
                <label>Phone</label>
                <input type="tel" id="s-agencyPhone" value="${Utils.escHtml(settings.agencyPhone)}" />
              </div>
              <div class="form-group">
                <label>Website</label>
                <input type="text" id="s-agencyWebsite" value="${Utils.escHtml(settings.agencyWebsite)}" />
              </div>
              <div class="form-group form-full">
                <label>Address</label>
                <textarea id="s-agencyAddress" rows="3">${Utils.escHtml(settings.agencyAddress)}</textarea>
              </div>
            </div>
          </div>

          <!-- Invoice Defaults -->
          <div class="editor-section">
            <h2 class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
              Invoice Defaults
            </h2>
            <div class="form-grid">
              <div class="form-group">
                <label>Currency</label>
                <select id="s-currency">
                  ${currencies.map(([code,,label]) =>
                    `<option value="${code}" ${settings.currency===code?'selected':''}>${label}</option>`
                  ).join('')}
                </select>
              </div>
              <div class="form-group">
                <label>Tax Label</label>
                <input type="text" id="s-taxLabel" value="${Utils.escHtml(settings.taxLabel)}" placeholder="VAT / GST / Tax" />
              </div>
              <div class="form-group">
                <label>Default Tax Rate (%)</label>
                <input type="number" id="s-defaultTaxRate" min="0" max="100" step="0.5" value="${settings.defaultTaxRate}" />
              </div>
              <div class="form-group form-full">
                <label>Default Payment Terms</label>
                <textarea id="s-defaultPaymentTerms" rows="2">${Utils.escHtml(settings.defaultPaymentTerms)}</textarea>
              </div>
              <div class="form-group form-full">
                <label>Bank / Payment Details (shown on every invoice)</label>
                <textarea id="s-bankDetails" rows="5">${Utils.escHtml(settings.bankDetails)}</textarea>
              </div>
            </div>
          </div>

          <!-- Branding -->
          <div class="editor-section">
            <h2 class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
              Branding & Appearance
            </h2>
            <div class="form-grid">
              <div class="form-group">
                <label>Primary Colour (Invoice Header)</label>
                <div class="color-input">
                  <input type="color" id="s-accentColor" value="${settings.accentColor || '#7c3aed'}" />
                  <input type="text" id="s-accentColorText" value="${settings.accentColor || '#7c3aed'}" maxlength="7" placeholder="#7c3aed" />
                </div>
              </div>
              <div class="form-group">
                <label>Secondary Colour (Gradient Accent)</label>
                <div class="color-input">
                  <input type="color" id="s-accentColorSecondary" value="${settings.accentColorSecondary || '#f59e0b'}" />
                  <input type="text" id="s-accentColorSecondaryText" value="${settings.accentColorSecondary || '#f59e0b'}" maxlength="7" placeholder="#f59e0b" />
                </div>
              </div>
              <div class="form-group form-full">
                <label>Logo (PNG, JPG or SVG — displayed on every invoice)</label>
                <div class="logo-upload">
                  ${settings.logoUrl
                    ? `<img src="${settings.logoUrl}" alt="Agency logo" style="max-height:80px;max-width:200px;border-radius:8px;object-fit:contain" />`
                    : `<div class="logo-placeholder">
                        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        <p>Click to upload your logo</p>
                        <small style="opacity:.6">Recommended: 400×120px PNG on transparent background</small>
                      </div>`
                  }
                  <input type="file" id="s-logo" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer" onchange="Settings.handleLogo(this)" />
                </div>
                ${settings.logoUrl ? `<button class="btn btn-ghost" style="margin-top:8px" onclick="Settings.removeLogo()">Remove Logo</button>` : ''}
              </div>
            </div>
          </div>

        </div>
      </div>`;

    // Sync color pickers ↔ text inputs
    document.getElementById('s-accentColor').addEventListener('input', e => {
      document.getElementById('s-accentColorText').value = e.target.value;
    });
    document.getElementById('s-accentColorText').addEventListener('input', e => {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
        document.getElementById('s-accentColor').value = e.target.value;
    });
    document.getElementById('s-accentColorSecondary').addEventListener('input', e => {
      document.getElementById('s-accentColorSecondaryText').value = e.target.value;
    });
    document.getElementById('s-accentColorSecondaryText').addEventListener('input', e => {
      if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
        document.getElementById('s-accentColorSecondary').value = e.target.value;
    });
  },

  handleLogo(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const settings = Storage.getSettings();
      settings.logoUrl = e.target.result;
      Storage.saveSettings(settings);
      Toast.show('Logo uploaded!');
      this.render();
    };
    reader.readAsDataURL(file);
  },

  removeLogo() {
    const settings = Storage.getSettings();
    settings.logoUrl = null;
    Storage.saveSettings(settings);
    Toast.show('Logo removed', 'info');
    this.render();
  },

  save() {
    const settings  = Storage.getSettings();
    const currency  = document.getElementById('s-currency').value;
    const symMap    = { GBP:'£', USD:'$', EUR:'€', NGN:'₦', CAD:'CA$', AUD:'A$', ZAR:'R', GHS:'₵', KES:'KSh' };

    Object.assign(settings, {
      agencyName:           document.getElementById('s-agencyName').value.trim(),
      agencyTagline:        document.getElementById('s-agencyTagline').value.trim(),
      agencyEmail:          document.getElementById('s-agencyEmail').value.trim(),
      agencyPhone:          document.getElementById('s-agencyPhone').value.trim(),
      agencyWebsite:        document.getElementById('s-agencyWebsite').value.trim(),
      agencyAddress:        document.getElementById('s-agencyAddress').value.trim(),
      currency,
      currencySymbol:       symMap[currency] || currency,
      taxLabel:             document.getElementById('s-taxLabel').value.trim() || 'Tax',
      defaultTaxRate:       parseFloat(document.getElementById('s-defaultTaxRate').value) || 0,
      defaultPaymentTerms:  document.getElementById('s-defaultPaymentTerms').value.trim(),
      bankDetails:          document.getElementById('s-bankDetails').value.trim(),
      accentColor:          document.getElementById('s-accentColor').value,
      accentColorSecondary: document.getElementById('s-accentColorSecondary').value,
    });

    Storage.saveSettings(settings);
    Toast.show('Settings saved successfully!');

    const navName = document.getElementById('nav-agency-name');
    if (navName) navName.textContent = settings.agencyName;
  },
};

// ============================================================
// APP INIT
// ============================================================
function initApp() {
  const settings = Storage.getSettings();
  const navName  = document.getElementById('nav-agency-name');
  if (navName) navName.textContent = settings.agencyName;

  Router
    .on('dashboard', ()   => Overview.render())
    .on('invoices',  ()   => Dashboard.render())
    .on('editor',    (id) => Editor.render(id || 'new'))
    .on('preview',   (id) => Preview.render(id))
    .on('expenses',  ()   => Expenses.render())
    .on('settings',  ()   => Settings.render())
    .init();
}

document.addEventListener('DOMContentLoaded', () => {
  Cloud.init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
});
