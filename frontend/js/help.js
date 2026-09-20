/* ProtectionPro — Help reference viewer.
 *
 * The "Reference" tab of the Help modal: a searchable list of articles, one per
 * calculation or tool, each written as HTML with TeX maths between $…$ (inline)
 * and $$…$$ (display). The articles are plain data, appended by the help-*.js
 * files to HELP_ARTICLES; this module only lists, searches and renders them.
 *
 * KaTeX (js/lib/katex) is loaded the first time the tab is opened, not at app
 * start, so it costs nothing until someone reads an equation. If it cannot be
 * loaded the article still reads — the TeX source is shown as plain text.
 *
 *   HELP_GROUPS   ordered [{id, title}] — the sections of the article list
 *   HELP_ARTICLES {id, group, title, std, kw, html} — appended by help-*.js
 */
const HELP_GROUPS = [
  { id: 'faults',    title: 'Short circuit & faults' },
  { id: 'flow',      title: 'Load flow & network studies' },
  { id: 'dynamics',  title: 'Motors, stability & power quality' },
  { id: 'protect',   title: 'Protection & safety' },
  { id: 'cables',    title: 'Cables & circuits' },
  { id: 'design',    title: 'Reticulation, building & plans' },
  { id: 'workflow',  title: 'Studies, scenarios & logic' },
];
const HELP_ARTICLES = [];

const HelpCenter = {
  _katex: null,          // null = not tried, 'loading', 'ready', 'failed'
  _waiters: [],
  _current: null,
  _inited: false,
  _idx: null,

  // ── Loading KaTeX on demand ──
  _load() {
    if (this._katex === 'ready') return Promise.resolve(true);
    if (this._katex === 'failed') return Promise.resolve(false);
    return new Promise(resolve => {
      this._waiters.push(resolve);
      if (this._katex === 'loading') return;
      this._katex = 'loading';
      const base = 'js/lib/katex/';
      const v = document.querySelector('script[src*="js/app.js"]')?.src.match(/\?v=([^&]+)/)?.[1] || '';
      const q = v ? `?v=${v}` : '';
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${base}katex.min.css${q}`;
      document.head.appendChild(link);
      const script = (src) => new Promise((ok, no) => {
        const s = document.createElement('script');
        s.src = `${base}${src}${q}`;
        s.onload = ok; s.onerror = no;
        document.head.appendChild(s);
      });
      script('katex.min.js').then(() => script('auto-render.min.js')).then(() => {
        this._katex = 'ready';
      }).catch(() => {
        this._katex = 'failed';
      }).finally(() => {
        const ok = this._katex === 'ready';
        this._waiters.splice(0).forEach(fn => fn(ok));
      });
    });
  },

  _renderMath(el) {
    if (this._katex !== 'ready' || typeof renderMathInElement !== 'function') return;
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'style', 'textarea', 'pre', 'code'],
    });
  },

  // ── UI ──
  init() {
    if (this._inited) return;
    const root = document.getElementById('help-tab-reference');
    if (!root) return;
    this._inited = true;
    this._list = root.querySelector('.hc-list');
    this._article = root.querySelector('.hc-article');
    this._search = root.querySelector('.hc-search');
    this._count = root.querySelector('.hc-count');
    this._search.addEventListener('input', () => this._renderList());
    this._search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._moveCursor(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._moveCursor(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const r = this._results[Math.max(0, this._cursor)];
        if (r) this.show(r.a.id);
      } else if (e.key === 'Escape' && this._search.value) {
        e.stopPropagation(); this._search.value = ''; this._renderList();
      }
    });
    this._list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-article]');
      if (b) this.show(b.dataset.article);
    });
    // Links between articles: <a href="#" data-help="id">
    this._article.addEventListener('click', (e) => {
      const a = e.target.closest('[data-help]');
      if (!a) return;
      e.preventDefault();
      this.show(a.dataset.help);
    });
    this._renderList();
    this.show(HELP_ARTICLES[0]?.id);
  },

  // ── Search ──
  // Words people type that the articles spell differently.
  _ALIASES: {
    sag: ['dip', 'depression'], dip: ['sag'], earth: ['ground', 'grounding', 'earthing'],
    ground: ['earth', 'earthing'], earthing: ['ground', 'earth'], loadflow: ['load flow'],
    vd: ['voltage drop'], scc: ['short circuit'], sc: ['short circuit'], fault: ['short circuit'],
    ampacity: ['current carrying', 'derating'], derate: ['derating'], cti: ['grading', 'margin'],
    grading: ['coordination', 'cti'], harmonic: ['thd', 'harmonics'], thd: ['harmonics', 'distortion'],
    pv: ['solar'], solar: ['pv'], battery: ['bess', 'soc'], bess: ['battery'], ups: ['battery'],
    rcd: ['earth leakage'], demand: ['admd', 'diversity'], admd: ['demand'], erf: ['erven'],
    arcflash: ['arc flash'], ppe: ['arc flash', 'incident energy'], relay: ['idmt', 'tcc'],
    curve: ['tcc', 'idmt'], resonance: ['frequency scan'], stability: ['transient', 'voltage stability'],
    outage: ['contingency', 'reliability'], cost: ['boq', 'rates'], price: ['rates', 'boq'],
    quantity: ['boq'], lux: ['lighting', 'illuminance'], light: ['lighting', 'lux'],
  },

  // Plain text of an article for searching: TeX and tags removed, so a query
  // like "frac" or "sqrt" cannot hit equation source.
  _index(a) {
    if (!this._idx) this._idx = {};
    if (this._idx[a.id]) return this._idx[a.id];
    const d = document.createElement('div');
    d.innerHTML = a.html.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ');
    const heads = [...d.querySelectorAll('h4,h5')].map(h => h.textContent).join(' ');
    const body = d.textContent.replace(/\s+/g, ' ').trim();
    return (this._idx[a.id] = {
      title: a.title.toLowerCase(),
      kw: (a.kw || '').toLowerCase(),
      std: (a.std || '').toLowerCase(),
      heads: heads.toLowerCase(),
      body, low: body.toLowerCase(),
    });
  },

  _terms(q) {
    return q.toLowerCase().replace(/[^\p{L}\p{N}\s.+/-]/gu, ' ').split(/\s+/).filter(Boolean);
  },

  _wordHit(text, t) {          // whole-word / word-start match
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
    const m = re.exec(text);
    return m ? m.index + m[1].length : -1;
  },

  // Score one article for a list of terms. Every term must match somewhere
  // (directly or through an alias); returns null when one is missing.
  _score(a, terms) {
    const ix = this._index(a);
    let total = 0, snippetAt = -1, snippetLen = 0;
    for (const t of terms) {
      const alts = [t, ...(this._ALIASES[t] || [])];
      let best = 0;
      for (const [k, alt] of alts.map((x, n) => [n, x])) {
        const w = k === 0 ? 1 : 0.6;               // an alias counts a little less
        let sc = 0;
        if (this._wordHit(ix.title, alt) >= 0) sc = Math.max(sc, ix.title.split(/\s+/).includes(alt) ? 30 : 22);
        else if (ix.title.includes(alt)) sc = Math.max(sc, 14);
        if (this._wordHit(ix.kw, alt) >= 0) sc = Math.max(sc, 12);
        if (this._wordHit(ix.heads, alt) >= 0) sc = Math.max(sc, 9);
        if (ix.std.includes(alt)) sc = Math.max(sc, 6);
        const at = this._wordHit(ix.low, alt);
        if (at >= 0) {
          const n = Math.min(3, ix.low.split(alt).length - 1);
          sc = Math.max(sc, 2 + n);
          if (snippetAt < 0) { snippetAt = at; snippetLen = alt.length; }
        } else if (alt.length >= 3) {
          const at2 = ix.low.indexOf(alt);
          if (at2 >= 0) { sc = Math.max(sc, 1); if (snippetAt < 0) { snippetAt = at2; snippetLen = alt.length; } }
        }
        best = Math.max(best, sc * w);
      }
      if (best === 0) return null;
      total += best;
    }
    // A phrase that appears verbatim is a much better match than scattered words.
    if (terms.length > 1 || this._phrase !== terms.join(' ')) {
      const phrase = this._phrase || terms.join(' ');
      if (ix.kw.includes(phrase)) total += 20;
      if (ix.heads.includes(phrase)) total += 10;
      if (ix.title.includes(phrase)) total += 25;
      if (!ix.title.includes(phrase) && ix.low.includes(phrase)) { total += 8; snippetAt = ix.low.indexOf(phrase); snippetLen = phrase.length; }
    }
    return { a, score: total, snippetAt, snippetLen, ix };
  },

  _esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },

  _mark(text, terms) {
    let out = this._esc(text);
    const all = [...new Set(terms.flatMap(t => [t, ...(this._ALIASES[t] || [])]))]
      .filter(t => t.length > 1).sort((x, y) => y.length - x.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!all.length) return out;
    return out.replace(new RegExp('(?<![\\p{L}\\p{N}])(' + all.join('|') + ')', 'giu'), '<mark>$1</mark>');
  },

  _snippet(r, terms) {
    if (r.snippetAt < 0) return '';
    const body = r.ix.body;
    const from = Math.max(0, r.snippetAt - 45);
    const to = Math.min(body.length, r.snippetAt + r.snippetLen + 90);
    return (from > 0 ? '… ' : '') + this._mark(body.slice(from, to), terms) + (to < body.length ? ' …' : '');
  },

  _results: [],
  _cursor: -1,

  _renderList() {
    const q = (this._search.value || '').trim();
    const words = this._terms(q);
    // A lone letter ("k" in "k factor") matches almost everything; it only counts inside the phrase.
    const terms = words.length > 1 ? words.filter(w => w.length > 1) : words;
    this._phrase = words.join(' ');
    const cnt = this._count;
    if (!terms.length) {
      this._results = []; this._cursor = -1;
      cnt.textContent = `${HELP_ARTICLES.length} articles`;
      let html = '';
      for (const g of HELP_GROUPS) {
        const items = HELP_ARTICLES.filter(a => a.group === g.id);
        if (!items.length) continue;
        html += `<div class="hc-group">${g.title}</div>`;
        for (const a of items) {
          html += `<button type="button" class="hc-item${a.id === this._current ? ' active' : ''}" data-article="${a.id}">${a.title}</button>`;
        }
      }
      this._list.innerHTML = html;
      return;
    }
    const res = HELP_ARTICLES.map(a => this._score(a, terms)).filter(Boolean)
      .sort((x, y) => y.score - x.score || HELP_ARTICLES.indexOf(x.a) - HELP_ARTICLES.indexOf(y.a));
    this._results = res;
    this._cursor = res.length ? 0 : -1;
    cnt.textContent = res.length ? `${res.length} match${res.length === 1 ? '' : 'es'} — Enter opens the top one` : '';
    if (!res.length) {
      this._list.innerHTML = `<div class="hc-none">No article matches “${this._esc(q)}”.<br>Try a single word such as <em>sag</em>, <em>earth fault</em> or <em>ampacity</em>.</div>`;
      return;
    }
    const gname = id => (HELP_GROUPS.find(g => g.id === id) || {}).title || '';
    this._list.innerHTML = res.map((r, n) =>
      `<button type="button" class="hc-item hc-result${n === 0 ? ' cursor' : ''}${r.a.id === this._current ? ' active' : ''}" data-article="${r.a.id}" data-n="${n}">` +
      `<span class="hc-rtitle">${this._mark(r.a.title, terms)}</span>` +
      `<span class="hc-rgroup">${gname(r.a.group)}</span>` +
      (this._snippet(r, terms) ? `<span class="hc-snip">${this._snippet(r, terms)}</span>` : '') +
      `</button>`).join('');
  },

  _moveCursor(d) {
    if (!this._results.length) return;
    this._cursor = (this._cursor + d + this._results.length) % this._results.length;
    const items = this._list.querySelectorAll('.hc-result');
    items.forEach((el, n) => el.classList.toggle('cursor', n === this._cursor));
    items[this._cursor]?.scrollIntoView({ block: 'nearest' });
  },

  // Highlight the searched words inside the open article (text nodes only, so
  // typeset maths and links are left alone).
  _highlight(root, terms) {
    if (!terms.length) return;
    const words = [...new Set(terms.flatMap(t => [t, ...(this._ALIASES[t] || [])]))]
      .filter(t => t.length > 1 && !/\s/.test(t)).sort((x, y) => y.length - x.length)
      .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return;
    const re = new RegExp('(?<![\\p{L}\\p{N}])(' + words.join('|') + ')', 'giu');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('.katex, mark, script, style') ? NodeFilter.FILTER_REJECT
        : (re.lastIndex = 0, re.test(n.nodeValue)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const span = document.createElement('span');
      span.innerHTML = this._esc(n.nodeValue).replace(new RegExp('(?<![\\p{L}\\p{N}])(' + words.join('|') + ')', 'giu'), '<mark class="hc-hit">$1</mark>');
      n.replaceWith(...span.childNodes);
    }
    root.querySelector('.hc-hit')?.scrollIntoView({ block: 'center' });
  },

  async show(id) {
    const a = HELP_ARTICLES.find(x => x.id === id);
    if (!a || !this._article) return;
    this._current = id;
    const i = HELP_ARTICLES.indexOf(a);
    const prev = HELP_ARTICLES[i - 1], next = HELP_ARTICLES[i + 1];
    const g = HELP_GROUPS.find(x => x.id === a.group);
    this._article.innerHTML =
      `<div class="hc-crumb">${g ? g.title : ''}</div>` +
      `<h3 class="hc-title">${a.title}</h3>` +
      (a.std ? `<div class="hc-std">${a.std}</div>` : '') +
      `<div class="hc-body">${a.html}</div>` +
      `<div class="hc-pager">` +
        (prev ? `<a href="#" data-help="${prev.id}">‹ ${prev.title}</a>` : '<span></span>') +
        (next ? `<a href="#" data-help="${next.id}">${next.title} ›</a>` : '<span></span>') +
      `</div>`;
    this._article.scrollTop = 0;
    this._list.querySelectorAll('.hc-item').forEach(b =>
      b.classList.toggle('active', b.dataset.article === id));
    const cur = this._results.findIndex(r => r.a.id === id);
    if (cur >= 0) this._cursor = cur;
    const body = this._article.querySelector('.hc-body');
    const terms = this._terms(this._search?.value || '');
    if (await this._load() && this._current === id) this._renderMath(body);
    if (this._current === id) this._highlight(body, terms);
  },

  // Open the Help modal on an article (used by other modules / Ctrl K).
  open(id) {
    document.getElementById('help-modal').style.display = '';
    document.querySelector('.help-tab[data-tab="reference"]')?.click();
    if (id) this.show(id);
    else setTimeout(() => this._search?.focus(), 0);
  },

  // The tab was selected — build the list on first use.
  onTab() { this.init(); },
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.help-tab[data-tab="reference"]')
    ?.addEventListener('click', () => HelpCenter.onTab());
});
