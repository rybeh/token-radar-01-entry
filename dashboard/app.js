// Token Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders three views of the one dataset: the ranked board of pre-token protocols, the
// live-token protocols the model prices from (kept apart, at market values), and the method
// itself. The board is sortable and filterable; every row opens a detail drawer that shows
// the model's arithmetic for that protocol and its farm plan. No network: every byte it
// shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var M = DATA.model;

  var params = new URLSearchParams(window.location.search);
  var state = {
    tab: params.get('tab') || 'board',
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    chain: params.get('chain') || 'all',
    watch: params.get('watch') === '1',
    sort: 'rank',
    dir: 1,
    shown: 60,
    selected: params.get('detail') || null,
  };

  // ------------------------------------------------------------ formatting

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }
  function fmtMult(n) {
    return n.toFixed(2) + 'x';
  }

  // The model in one function: the page recomputes a row's implied value from the snapshot
  // figures and the model's stated constants, so the page's code and board.json's number are
  // visibly the same arithmetic. buildRadar in lib/model.ts rounds each multiplier to 4
  // places before multiplying; this does the same and lands on the same dollar.
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * row.growth_multiplier * row.maturity_multiplier));
  }

  // ------------------------------------------------------------ dom helpers

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function td(cls, text) { return el('td', cls, text); }

  var boardEl = document.getElementById('board');
  var countEl = document.getElementById('count');

  // ------------------------------------------------------------ header & stats

  document.querySelector('#model-chip b').textContent = DATA.model_version;
  document.querySelector('#asof-chip b').textContent = DATA.as_of;
  var totalImplied = DATA.rows.reduce(function (n, r) { return n + r.implied_value_usd; }, 0);
  var stats = [
    [String(DATA.counts.ranked), 'protocols ranked', true],
    [DATA.counts.watchlist + ' of ' + DATA.counts.watchlist, 'watchlist covered', false],
    [String(DATA.counts.pre_token), 'record no token', false],
    [String(DATA.counts.live), 'already trade, kept apart', false],
    [fmtUsd(totalImplied), 'implied launch value', false],
    [fmtUsd(DATA.rows[0].implied_value_usd), 'top of the board', false],
  ];
  var statsEl = document.getElementById('stats');
  stats.forEach(function (s) {
    var box = el('div', 'stat' + (s[2] ? ' hot' : ''));
    box.appendChild(el('div', 'v', s[0]));
    box.appendChild(el('div', 'k', s[1]));
    statsEl.appendChild(box);
  });
  document.getElementById('foot').textContent =
    'Built by a program from the sealed snapshot alone (' + DATA.source + '): no network, no hand-kept list. ' +
    'An implied value is this model\'s claim about a launch that may never happen, not a prediction and not advice.';

  // ------------------------------------------------------------ controls

  var qEl = document.getElementById('q');
  var catEl = document.getElementById('category');
  var chainEl = document.getElementById('chain');
  var watchEl = document.getElementById('watch');
  qEl.value = state.q;
  watchEl.checked = state.watch;

  function fillSelect(select, values, allLabel, current) {
    select.appendChild(el('option', null, allLabel)).value = 'all';
    values.forEach(function (v) {
      var o = el('option', null, v);
      o.value = v;
      select.appendChild(o);
    });
    select.value = current;
  }
  var categories = [];
  var chains = [];
  DATA.rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) < 0) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  categories.sort();
  chains.sort();
  fillSelect(catEl, categories, 'All categories', state.category);
  fillSelect(chainEl, chains, 'All chains', state.chain);

  qEl.addEventListener('input', function () { state.q = qEl.value; state.shown = 60; render(); });
  catEl.addEventListener('change', function () { state.category = catEl.value; state.shown = 60; render(); });
  chainEl.addEventListener('change', function () { state.chain = chainEl.value; state.shown = 60; render(); });
  watchEl.addEventListener('change', function () { state.watch = watchEl.checked; state.shown = 60; render(); });

  var tabButtons = document.querySelectorAll('#tabs button');
  tabButtons.forEach(function (b) {
    b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); render(); });
  });

  // ------------------------------------------------------------ the board

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
  }

  function sorted(rows) {
    var key = state.sort, dir = state.dir;
    var val = {
      rank: function (r) { return r.rank; },
      name: function (r) { return r.name.toLowerCase(); },
      tvl: function (r) { return r.tvl_usd; },
      change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days === null ? -1 : r.age_days; },
      multiple: function (r) { return r.category_multiple; },
      implied: function (r) { return r.implied_value_usd; },
    }[key];
    return rows.slice().sort(function (a, b) {
      var x = val(a), y = val(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return a.rank - b.rank;
    });
  }

  var COLUMNS = [
    ['rank', '#', ''],
    ['name', 'Protocol', 'l'],
    ['category', 'Category', 'l'],
    ['chains', 'Chains', 'l'],
    ['tvl', 'TVL', ''],
    ['change', '7d', ''],
    ['age', 'No token for', ''],
    ['multiple', 'x TVL', ''],
    ['implied', 'Implied value', ''],
  ];

  function renderBoard() {
    var rows = sorted(filtered());
    countEl.textContent = rows.length + ' of ' + DATA.rows.length + ' protocols';
    var wrap = el('div', 'board');
    var table = el('table');
    var thead = el('thead');
    var trh = el('tr');
    COLUMNS.forEach(function (c) {
      var sortable = c[0] !== 'chains' && c[0] !== 'category';
      var th = el('th', (c[2] === 'l' ? 'l' : '') + (sortable ? ' sortable' : ''), c[1]);
      if (state.sort === c[0]) {
        th.appendChild(el('span', 'dir', state.dir === 1 ? ' ↑' : ' ↓'));
      }
      if (sortable) {
        th.addEventListener('click', function () {
          if (state.sort === c[0]) state.dir = -state.dir;
          else { state.sort = c[0]; state.dir = c[0] === 'name' ? 1 : -1; if (c[0] === 'rank') state.dir = 1; }
          render();
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = el('tbody');
    if (rows.length === 0) {
      var tr = el('tr');
      var cell = td('l empty', 'No protocol matches this filter. Loosen it: the radar tracks ' + DATA.rows.length + ' pre-token protocols.');
      cell.colSpan = COLUMNS.length;
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
    rows.slice(0, state.shown).forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(td('rank', String(r.rank)));
      var nameCell = td('l name');
      var nm = el('span', 'pname', r.name);
      nameCell.appendChild(nm);
      if (r.watchlist) nameCell.appendChild(el('span', 'wl', 'WATCHLIST'));
      nameCell.appendChild(el('span', 'slug', r.slug));
      tr.appendChild(nameCell);
      tr.appendChild(td('l cat', r.category || '—'));
      tr.appendChild(td('l chains', r.chains.length ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') : '—'));
      tr.appendChild(td('num', fmtUsd(r.tvl_usd)));
      var ch = td('num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), fmtPct(r.change_7d));
      tr.appendChild(ch);
      tr.appendChild(td('num', fmtAge(r.age_days)));
      tr.appendChild(td('num', fmtMult(r.category_multiple)));
      tr.appendChild(td('implied', fmtUsd(r.implied_value_usd)));
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    boardEl.appendChild(wrap);
    if (rows.length > state.shown) {
      var more = el('button', 'more', 'Show all ' + rows.length + ' protocols');
      more.addEventListener('click', function () { state.shown = rows.length; render(); });
      boardEl.appendChild(more);
    }
  }

  // ------------------------------------------------------------ live tokens

  function renderLive() {
    countEl.textContent = 'the ' + DATA.live.length + ' largest of ' + DATA.counts.live + ' that already trade';
    var note = el('p', 'live-note',
      'These protocols already have a token, so the radar never ranks them and never invents a value for them: ' +
      'the market cap is the market\'s own. Their market-cap-to-TVL ratios are the comparable launches the board ' +
      'is priced from — the median across all of them is ' + DATA.global_multiple.toFixed(4) + 'x.');
    boardEl.appendChild(note);
    var wrap = el('div', 'board');
    var table = el('table');
    var thead = el('thead');
    var trh = el('tr');
    [['Protocol', 'l'], ['Category', 'l'], ['Chains', 'l'], ['TVL', ''], ['Market cap', ''], ['Cap / TVL', ''], ['7d', '']].forEach(function (c) {
      trh.appendChild(el('th', c[1], c[0]));
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      var tr = el('tr');
      var nameCell = td('l name');
      nameCell.appendChild(el('span', 'pname', r.name));
      nameCell.appendChild(el('span', 'slug', r.slug));
      tr.appendChild(nameCell);
      tr.appendChild(td('l cat', r.category || '—'));
      tr.appendChild(td('l chains', r.chains.length ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') : '—'));
      tr.appendChild(td('num', fmtUsd(r.tvl_usd)));
      tr.appendChild(td('num', fmtUsd(r.mcap_usd)));
      tr.appendChild(td('num', r.mcap_tvl === null ? 'n/a' : r.mcap_tvl.toFixed(3) + 'x'));
      tr.appendChild(td('num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'), fmtPct(r.change_7d)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    boardEl.appendChild(wrap);
  }

  // ------------------------------------------------------------ the method

  function renderMethod() {
    countEl.textContent = 'model ' + DATA.model_version + ', stated in full';
    var box = el('div', 'method');
    var top = DATA.rows[0];
    box.appendChild(el('h2', null, 'How the value is derived'));
    var p1 = el('p');
    p1.innerHTML = 'The snapshot carries no ranking and no value: it says what each protocol <b>is</b>, never what a launch ' +
      'would be worth. This radar derives the value the way a market would — from the launches that already happened. ' +
      'Of the snapshot\'s ' + DATA.counts.protocols + ' protocols, ' + DATA.counts.pre_token + ' record no token. The board ranks ' +
      DATA.counts.ranked + ' of them: every one of the ' + DATA.counts.watchlist + ' on the house watchlist, plus the pre-token ' +
      'protocols below its floor that are not a wrapped, staked or bridged product of a token that trades, not an exchange ' +
      'and not a versioned pool of another protocol. Those products are excluded by the same rule the watchlist states, ' +
      'because their token, or their parent\'s, already exists.';
    box.appendChild(p1);
    var f = el('p', 'formula',
      'implied = TVL x category multiple x growth multiplier x maturity multiplier');
    box.appendChild(f);

    box.appendChild(el('h3', null, '1 · The category multiple: priced from comparable launches'));
    var p2 = el('p');
    p2.innerHTML = 'For every token-bearing protocol in the snapshot, take <b>market cap / TVL</b>. One distressed or euphoric ' +
      'token must not price a category, so each ratio is first <b>winsorized to [0.02, 5]</b>. A category\'s multiple is its ' +
      'median ratio, <b>shrunk toward the market-wide median</b> (' + DATA.global_multiple.toFixed(4) + 'x across ' +
      DATA.comps.reduce(function (n, c) { return n + c.n; }, 0) + ' comparable launches) with weight n/(n+' + M.shrink_weight + '): a category with fifteen launches mostly speaks for ' +
      'itself, one with a single launch mostly inherits the market\'s price. The result is <b>clamped to [0.05, 1.50]</b>, the ' +
      'range where the bulk of comparable launches actually trade. A category with no comparable launch uses the market median.';
    box.appendChild(p2);

    box.appendChild(el('h3', null, '2 · Growth: a week of momentum, lightly held'));
    var p3 = el('p');
    p3.innerHTML = 'The seven-day TVL change, clamped to [' + M.growth_floor + '%, +' + M.growth_cap + '%] and weighted ' +
      M.growth_weight + ': the multiplier runs from ' + (1 + M.growth_floor / 100 * M.growth_weight).toFixed(3) + ' to ' +
      (1 + M.growth_cap / 100 * M.growth_weight).toFixed(2) + '. A protocol DefiLlama reports no change for is taken as flat. ' +
      'Growth is evidence about demand, not the basis of the price, so its weight is deliberately small.';
    box.appendChild(p3);

    box.appendChild(el('h3', null, '3 · Maturity: how long it has run with no token'));
    var p4 = el('p');
    p4.innerHTML = 'A protocol that has operated for years without issuing a token has a proven product and a user base ' +
      'waiting on the other side of a launch; one that appeared last month has neither. The maturity multiplier rises ' +
      'from ' + M.maturity_base + ' for a brand-new protocol to ' + (M.maturity_base + M.maturity_span).toFixed(2) + ' at ' +
      (M.maturity_days / 365).toFixed(0) + ' years tokenless, measured from the day DefiLlama began tracking it to the ' +
      'snapshot\'s date. An unreported start counts as neutral, 1.00.';
    box.appendChild(p4);

    box.appendChild(el('h3', null, 'The top of the board, worked in the open'));
    var p5 = el('p');
    p5.innerHTML = '<b>' + top.name + '</b> holds ' + fmtFull(top.tvl_usd) + ' of TVL. Its category, ' + (top.category || '—') +
      ', has ' + top.comp_count + ' comparable launch' + (top.comp_count === 1 ? '' : 'es') + ' in the snapshot, giving a multiple of ' +
      top.category_multiple.toFixed(4) + 'x; its week was ' + fmtPct(top.change_7d) + ' (growth x' + top.growth_multiplier.toFixed(2) +
      ') and it has run ' + fmtAge(top.age_days) + ' with no token (maturity x' + top.maturity_multiplier.toFixed(2) + '). ' +
      fmtFull(top.tvl_usd) + ' x ' + top.category_multiple.toFixed(4) + ' x ' + top.growth_multiplier.toFixed(4) + ' x ' +
      top.maturity_multiplier.toFixed(4) + ' = <b>' + fmtFull(top.implied_value_usd) + '</b>. Every row on the board shows ' +
      'the same four factors in its detail view, and the page recomputes each row from them.';
    box.appendChild(p5);

    box.appendChild(el('h3', null, 'The multiples, category by category'));
    var table = el('table');
    var thead = el('thead');
    var trh = el('tr');
    [['Category', 'l'], ['Comparable launches', ''], ['Median cap / TVL', ''], ['Multiple used', '']].forEach(function (c) {
      trh.appendChild(el('th', c[1], c[0]));
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = el('tbody');
    DATA.comps.forEach(function (c) {
      var tr = el('tr');
      tr.appendChild(td('l cat', c.category));
      tr.appendChild(td('num', String(c.n)));
      tr.appendChild(td('num', c.median.toFixed(4) + 'x'));
      tr.appendChild(td('num', c.multiple.toFixed(4) + 'x'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);

    box.appendChild(el('h3', null, 'Farm plans, and the honest limits'));
    var p6 = el('p');
    p6.innerHTML = 'Each row\'s plan is built from its own record — its category sets the core action, its main chain the ' +
      'gas it costs, its TVL the capital a position needs, its age how long to hold — never from a list of names. ' +
      'And the limits, stated plainly: an implied value is a claim about a launch that may never happen, priced from ' +
      'one day\'s snapshot (' + DATA.as_of + '). It is a reason to look closer and a order to farm in, not a promise. ' +
      'Run the same program on a future snapshot and every figure is repriced from that day\'s own launches.';
    box.appendChild(p6);
    boardEl.appendChild(box);
  }

  // ------------------------------------------------------------ detail drawer

  function splitStep(step) {
    var ci = step.indexOf(' Cost: ');
    var ti = step.lastIndexOf(' Time: ');
    if (ci < 0 || ti < ci) return { act: step, cost: null, time: null };
    return {
      act: step.slice(0, ci),
      cost: step.slice(ci + 7, ti).replace(/\.$/, ''),
      time: step.slice(ti + 7).replace(/\.$/, ''),
    };
  }

  function openDetail(slug) {
    state.selected = slug;
    render();
  }
  function closeDetail() {
    state.selected = null;
    render();
  }

  function renderDetail() {
    if (!state.selected) return;
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
    if (!row) return;
    var scrim = el('div', 'scrim');
    scrim.addEventListener('click', closeDetail);
    document.body.appendChild(scrim);
    var d = el('aside', 'drawer');
    var close = el('button', 'close', 'x');
    close.addEventListener('click', closeDetail);
    d.appendChild(close);
    var kick = el('div', 'dslug', 'rank #' + row.rank + ' of ' + DATA.rows.length + (row.watchlist ? ' · on the house watchlist' : ' · below the watchlist floor'));
    d.appendChild(kick);
    d.appendChild(el('h2', null, row.name));
    d.appendChild(el('div', 'dslug', row.slug + ' · ' + (row.category || 'uncategorised')));
    d.appendChild(el('div', 'big', fmtFull(row.implied_value_usd)));
    d.appendChild(el('div', 'bigk', 'implied launch value · model ' + DATA.model_version));
    var note = el('p', 'note', 'This protocol records no token in the snapshot (DefiLlama, ' + DATA.as_of + '): no market cap, no CoinGecko id, no ticker. The value above is what its launch would be worth if its record stayed as it is.');
    d.appendChild(note);

    var eq = el('div', 'eq');
    function eqLine(label, factor, why) {
      var line = el('div', 'line');
      line.appendChild(el('span', null, label));
      line.appendChild(el('span', 'f', factor));
      var w = el('div', 'why', why);
      line.appendChild(w);
      return line;
    }
    eq.appendChild(eqLine('TVL', fmtFull(row.tvl_usd), 'the snapshot\'s figure'));
    eq.appendChild(eqLine('x category multiple', row.category_multiple.toFixed(4),
      (row.category || 'its category') + ', ' + row.comp_count + ' comparable launch' + (row.comp_count === 1 ? '' : 'es')));
    eq.appendChild(eqLine('x growth (7d ' + fmtPct(row.change_7d) + ')', row.growth_multiplier.toFixed(4), 'a week of momentum, weighted ' + M.growth_weight));
    eq.appendChild(eqLine('x maturity (' + fmtAge(row.age_days) + ' tokenless)', row.maturity_multiplier.toFixed(4), 'track record with no token'));
    var total = el('div', 'line total');
    total.appendChild(el('span', null, 'Implied value'));
    total.appendChild(el('span', 'f', fmtFull(impliedOf(row))));
    eq.appendChild(total);
    d.appendChild(eq);

    var facts = el('div', 'facts');
    [['Chains', row.chains.join(', ') || '—'],
     ['First tracked', row.listed_at || 'not reported'],
     ['Watchlist floor', row.tvl_usd >= DATA.floor_usd ? 'above the ' + fmtUsd(DATA.floor_usd) + ' floor' : 'below the ' + fmtUsd(DATA.floor_usd) + ' floor'],
     ['Board check', 'page recomputes ' + fmtFull(impliedOf(row))]].forEach(function (kv) {
      var cell = el('div');
      cell.appendChild(el('div', 'k', kv[0]));
      cell.appendChild(el('div', 'v', kv[1]));
      facts.appendChild(cell);
    });
    d.appendChild(facts);

    d.appendChild(el('h3', null, 'How to farm it'));
    var ol = el('ol', 'steps');
    row.farm_steps.forEach(function (s) {
      var parts = splitStep(s);
      var li = el('li');
      li.appendChild(el('span', 'act', parts.act));
      if (parts.cost || parts.time) {
        var meta = el('span', 'meta');
        if (parts.cost) meta.appendChild(el('span', null, 'Cost: ' + parts.cost));
        if (parts.time) meta.appendChild(el('span', null, 'Time: ' + parts.time));
        li.appendChild(meta);
      }
      ol.appendChild(li);
    });
    d.appendChild(ol);
    var risk = el('p', 'note', 'Farm only capital you can afford to lock up or lose. A token is a possibility this model prices, never a promise; if the protocol never issues one, the position has to be worth holding on its own.');
    d.appendChild(risk);
    document.body.appendChild(d);
  }

  // ------------------------------------------------------------ render

  function render() {
    boardEl.innerHTML = '';
    var old = document.querySelectorAll('.scrim, .drawer');
    old.forEach(function (n) { n.remove(); });
    tabButtons.forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === state.tab ? 'true' : 'false');
    });
    var showControls = state.tab === 'board';
    qEl.style.display = showControls ? '' : 'none';
    catEl.style.display = showControls ? '' : 'none';
    chainEl.style.display = showControls ? '' : 'none';
    watchEl.parentElement.style.display = showControls ? '' : 'none';
    if (state.tab === 'board') renderBoard();
    else if (state.tab === 'live') renderLive();
    else renderMethod();
    renderDetail();
  }

  render();
})();
