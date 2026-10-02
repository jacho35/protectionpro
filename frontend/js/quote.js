/* ProtectionPro — Quoted-project freeze
 *
 * Marking a project as quoted locks what a quote rests on: its rate library (prices, currency,
 * quantity rules) and the library entries it was built with. Company price / library changes
 * after that are shown as information and never applied; opening a quoted project uses the
 * entries it was quoted with (StandardData.reviewProjectLibraries). Reopening for editing is a
 * deliberate action. Every quoted / reopened event is kept in AppState.quoteLog.
 *
 *   AppState.quoted        { at, by, note } | null
 *   AppState.quotedLibrary { items, origins } — StandardData's snapshot taken when it was quoted
 *   AppState.quoteLog      [{ event: 'quoted'|'reopened', at, by, note }]
 */

const Quote = {
  isQuoted() { return !!(typeof AppState !== 'undefined' && AppState.quoted); },

  _who() {
    const u = typeof Auth !== 'undefined' ? Auth.user : null;
    return u ? ((u.name || '').trim() || u.email || '') : '';
  },
  _date(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  },
  // "Quoted 2 Oct 2026 by someone" — for banners, the BOQ header and the chip's tooltip.
  describe() {
    const q = AppState.quoted;
    if (!q) return '';
    return `Quoted ${this._date(q.at)}${q.by ? ' by ' + q.by : ''}${q.note ? ' — ' + q.note : ''}`;
  },

  async mark() {
    if (this.isQuoted()) return;
    const note = await UI.prompt('Mark this project as quoted? Its rates and the library entries it uses are locked as they are now, so later changes to your libraries or the company price list cannot alter the quote. You can reopen it for editing at any time.\n\nOptional note (e.g. the quote number):', '', { title: 'Mark as quoted', okText: 'Mark as quoted' });
    if (note === null || note === undefined) return;
    const at = new Date().toISOString(), by = this._who();
    const snap = (typeof StandardData !== 'undefined' && StandardData._collectUsed) ? StandardData._collectUsed() : { items: undefined, origins: undefined };
    AppState.quotedLibrary = snap.items ? { items: snap.items, origins: snap.origins } : null;
    AppState.quoted = { at, by, note: String(note).trim().slice(0, 200) };
    AppState.quoteLog.push({ event: 'quoted', at, by, note: AppState.quoted.note });
    AppState.dirty = true;
    this._changed();
    UI.toast('Marked as quoted — prices are locked. Save the project to keep it.', 'success', 6000);
  },

  async reopen() {
    if (!this.isQuoted()) return;
    const ok = await UI.confirm(`${this.describe()}.\n\nReopen it for editing? Prices and library entries will follow your libraries and the company price list again. The reopening is recorded.`, { title: 'Reopen for editing', okText: 'Reopen', danger: true });
    if (!ok) return;
    const at = new Date().toISOString(), by = this._who();
    AppState.quoteLog.push({ event: 'reopened', at, by, note: '' });
    AppState.quoted = null;
    AppState.quotedLibrary = null;
    AppState.dirty = true;
    this._changed();
    UI.toast('Reopened for editing.', 'info');
  },

  toggle() { return this.isQuoted() ? this.reopen() : this.mark(); },

  _changed() {
    this.refresh();
    if (typeof Rates !== 'undefined' && Rates.onQuoteChanged) Rates.onQuoteChanged();
  },

  // Chip beside the project type + the menu item's wording.
  refresh() {
    const q = this.isQuoted();
    const chip = document.getElementById('project-quoted-chip');
    if (chip) {
      chip.hidden = !q;
      if (q) { chip.textContent = `Quoted ${this._date(AppState.quoted.at)}`; chip.title = this.describe() + ' — click to reopen for editing'; }
    }
    const btn = document.getElementById('btn-quote');
    if (btn) btn.lastChild.textContent = q ? 'Reopen for Editing…' : 'Mark as Quoted…';
  },

  init() {
    document.getElementById('btn-quote')?.addEventListener('click', () => { window.closeAllToolbarMenus?.(); this.toggle(); });
    document.getElementById('project-quoted-chip')?.addEventListener('click', () => this.reopen());
    this.refresh();
  },
};
document.addEventListener('DOMContentLoaded', () => Quote.init());
