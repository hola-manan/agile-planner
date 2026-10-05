// public/js/lobby.js — the landing page: hero, join by code, start a game, recent games (SPEC §11, §12).
// Layout per design/Lobby.dc.html (desktop) and design/LobbyMobile.dc.html (phone).
import { html, useState, useEffect, useMemo, useRef } from './h.js';
import { apiCreate, listSessions, clearSession, normalizeCode, isValidCode } from './api.js';
import { primeRoom } from './room.js';
import { Button, Icon, Logo, Card, Switch, Seg, cx, fmt, toast, navigate, useIsMobile } from './ui.js';

const NAME_KEY = 'felt:name';
const DRAFT_KEY = 'felt:lastSettings';

function readLS(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled — nothing to remember */
  }
}

const DEFAULTS = {
  gameName: 'Friday Night Game',
  variant: 'NLH',
  sb: '1',
  bb: '2',
  seats: '8',
  minBuyIn: '100',
  maxBuyIn: '400',
  approveBuyIns: true,
  maxRuns: 2,
  revealRunout: 'anyone',
  showdownLosers: 'choose',
  actionTime: '25',
};

/** The last game's settings (so the weekly host doesn't retype them), merged over the defaults. */
function initialForm() {
  let saved = {};
  try {
    saved = JSON.parse(readLS(DRAFT_KEY, '{}')) || {};
  } catch {
    saved = {};
  }
  const f = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (saved[k] === undefined || saved[k] === null) continue;
    f[k] = typeof DEFAULTS[k] === 'string' ? String(saved[k]) : saved[k];
  }
  return f;
}

const intOf = (s) => (/^\s*\d+\s*$/.test(String(s)) ? Number(s) : NaN);
const digits = (s, max = 9) => String(s).replace(/[^0-9]/g, '').slice(0, max);

const RUN_OPTIONS = [
  { value: 1, label: 'Off' },
  { value: 2, label: 'Up to twice' },
  { value: 3, label: 'Up to 3 times' },
];
const REVEAL_OPTIONS = [
  { value: 'anyone', label: 'Anyone can' },
  { value: 'winner', label: 'Winner only' },
  { value: 'host', label: 'Host only' },
  { value: 'off', label: 'Off' },
];
const LOSER_OPTIONS = [
  { value: 'choose', label: 'Player chooses' },
  { value: 'show', label: 'Always shown' },
];
const TIMER_OPTIONS = [15, 20, 25, 30, 45, 60, 90, 120];

function validate(f, name) {
  const errs = {};
  if (!name.trim()) errs.hostName = 'Enter your name — it’s how the table sees you.';
  else if ([...name.trim()].length > 20) errs.hostName = 'Keep it to 20 characters.';
  if ([...f.gameName.trim()].length > 40) errs.gameName = 'Keep the game name to 40 characters.';
  const sb = intOf(f.sb);
  const bb = intOf(f.bb);
  const min = intOf(f.minBuyIn);
  const max = intOf(f.maxBuyIn);
  if (!(sb >= 1)) errs.sb = 'At least 1.';
  if (!(bb >= 1)) errs.bb = 'At least 1.';
  else if (sb >= 1 && bb < sb) errs.bb = 'Can’t be below the small blind.';
  if (!(min >= 1)) errs.minBuyIn = 'At least 1.';
  if (!(max >= 1)) errs.maxBuyIn = 'At least 1.';
  else if (min >= 1 && max < min) errs.maxBuyIn = 'Can’t be below the minimum.';
  return errs;
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function Field({ label, error, children, class: klass }) {
  return html`<label class=${cx('lob-f', klass)}>
    <span class="lob-f-label">${label}</span>
    ${children}
    ${error && html`<span class="lob-err" role="alert">${error}</span>`}
  </label>`;
}

function Row({ title, sub, children, stack }) {
  return html`<div class=${cx('lob-row', stack && 'lob-row-stack')}>
    <div class="lob-row-text">
      <div class="lob-row-title">${title}</div>
      <div class="muted lob-row-sub">${sub}</div>
    </div>
    ${children}
  </div>`;
}

function Select({ value, onChange, options, label, class: klass }) {
  return html`<select class=${cx('field', klass)} aria-label=${label} value=${String(value)} onChange=${(e) => {
    const o = options.find((x) => String(x.value) === e.target.value);
    onChange(o ? o.value : e.target.value);
  }}>
    ${options.map((o) => html`<option key=${String(o.value)} value=${String(o.value)}>${o.label}</option>`)}
  </select>`;
}

function HeroCards({ mobile }) {
  return html`<div class=${cx('lob-cards', mobile && 'lob-cards-m')} aria-hidden="true">
    <${Card} card="As" size=${mobile ? 'lg' : 'xl'} class="lob-card lob-card-1" />
    <${Card} card="Ah" size=${mobile ? 'lg' : 'xl'} class="lob-card lob-card-2" />
  </div>`;
}

function timeAgo(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  const d = Math.floor(s / 86400);
  if (d < 7) return d === 1 ? 'yesterday' : d + ' days ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function JoinBox({ mobile }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const c = normalizeCode(code);
    if (!isValidCode(c)) {
      setErr('Room codes look like RVR-4821 — three letters and four digits.');
      return;
    }
    navigate('/?room=' + encodeURIComponent(c));
  };
  return html`<form class="panel lob-join" onSubmit=${submit} noValidate>
    ${mobile
      ? html`<label class="label" for="lob-code">Join with a room code</label>`
      : html`<div class="lob-join-title">Join a game</div>`}
    <div class="lob-join-row">
      <label class="lob-join-field">
        ${!mobile && html`<span class="label">Room code</span>`}
        <input
          id="lob-code"
          class="field mono lob-code"
          placeholder="RVR-0000"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="9"
          value=${code}
          aria-invalid=${!!err}
          aria-label="Room code"
          onInput=${(e) => {
            setCode(e.target.value.toUpperCase());
            setErr('');
          }}
        />
      </label>
      <${Button} type="submit" class="lob-join-btn">Join<//>
    </div>
    ${err && html`<div class="lob-err" role="alert">${err}</div>`}
  </form>`;
}

function RecentGames() {
  const [list, setList] = useState(() => listSessions());
  useEffect(() => {
    const on = (e) => {
      if (!e.key || e.key.startsWith('felt:')) setList(listSessions());
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  if (!list.length) return null;
  const forget = (code) => {
    clearSession(code);
    setList(listSessions());
  };
  return html`<section class="lob-recent" aria-labelledby="lob-recent-h">
    <div class="label" id="lob-recent-h">Your games</div>
    <ul>
      ${list.slice(0, 6).map(
        (s) => html`<li key=${s.code} class="lob-recent-item">
          <a
            class="lob-recent-link"
            href=${'/?room=' + encodeURIComponent(s.code)}
            onClick=${(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              navigate('/?room=' + encodeURIComponent(s.code));
            }}
          >
            <span class="lob-recent-icon"><${Icon} name="spade" size=${18} /></span>
            <span class="lob-recent-main">
              <span class="lob-recent-name">${s.game || 'Home game'}</span>
              <span class="muted lob-recent-meta"><span class="mono">${s.code}</span>${s.name ? ' · as ' + s.name : ''}${s.t ? ' · ' + timeAgo(s.t) : ''}</span>
            </span>
          </a>
          <button type="button" class="btn btn-ghost btn-icon btn-sm lob-recent-x" aria-label=${'Forget ' + (s.game || s.code)} title="Remove from this list" onClick=${() => forget(s.code)}>
            <${Icon} name="close" size=${15} />
          </button>
        </li>`,
      )}
    </ul>
  </section>`;
}

// ─── create form ─────────────────────────────────────────────────────────────

function CreateForm({ mobile }) {
  const [f, setF] = useState(initialForm);
  const [name, setName] = useState(() => readLS(NAME_KEY, ''));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // buy-ins follow the big blind (50–200 BB) until the host edits them by hand
  const buyInsEdited = useRef(false);
  // …and the small blind follows it (half, rounded down) until edited
  const sbEdited = useRef(false);

  const errs = useMemo(() => validate(f, name), [f, name]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const setBB = (raw) => {
    const v = digits(raw, 7);
    setF((p) => {
      const n = { ...p, bb: v };
      const bb = intOf(v);
      if (!sbEdited.current && bb >= 1) n.sb = String(Math.max(1, Math.floor(bb / 2)));
      if (!buyInsEdited.current && bb >= 1) {
        n.minBuyIn = String(bb * 50);
        n.maxBuyIn = String(bb * 200);
      }
      return n;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (busy) return;
    if (Object.keys(errs).length) {
      const first = document.querySelector('.lob-create [aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    const hostName = name.trim();
    const settings = {
      variant: f.variant,
      sb: intOf(f.sb),
      bb: intOf(f.bb),
      seats: intOf(f.seats),
      minBuyIn: intOf(f.minBuyIn),
      maxBuyIn: intOf(f.maxBuyIn),
      approveBuyIns: !!f.approveBuyIns,
      maxRuns: Number(f.maxRuns),
      revealRunout: f.revealRunout,
      showdownLosers: f.showdownLosers,
      actionTime: intOf(f.actionTime),
    };
    setBusy(true);
    try {
      const res = await apiCreate({ hostName, gameName: f.gameName.trim() || 'Home Game', settings });
      writeLS(NAME_KEY, hostName);
      writeLS(DRAFT_KEY, JSON.stringify({ ...f, gameName: f.gameName.trim() || DEFAULTS.gameName }));
      primeRoom(res.code, res.view);
      navigate('/?room=' + encodeURIComponent(res.code));
    } catch (err) {
      toast(err.message || 'Couldn’t create the game.');
      setBusy(false);
    }
  };

  const err = (k) => (touched ? errs[k] : null);
  const numInput = (k, label, onInput) => html`<input
    class="field mono"
    inputmode="numeric"
    autocomplete="off"
    aria-label=${label}
    value=${f[k]}
    aria-invalid=${!!err(k)}
    onInput=${(e) => (onInput ? onInput(e.target.value) : set(k, digits(e.target.value)))}
  />`;

  const seatOptions = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: String(n) }));
  const variantOptions = mobile
    ? [
        { value: 'NLH', label: 'Hold’em' },
        { value: 'PLO', label: 'Omaha' },
      ]
    : [
        { value: 'NLH', label: 'No-Limit Hold’em' },
        { value: 'PLO', label: 'Pot-Limit Omaha' },
      ];

  const bbN = intOf(f.bb);
  const minN = intOf(f.minBuyIn);
  const maxN = intOf(f.maxBuyIn);
  const bbHint = bbN >= 1 && minN >= 1 && maxN >= minN ? `${fmt(Math.round(minN / bbN))}–${fmt(Math.round(maxN / bbN))} big blinds` : '';

  return html`<form class="panel lob-create" onSubmit=${submit} noValidate>
    <div class="lob-create-head">
      <h2>Start a game</h2>
      <span class="muted">You’ll be the host</span>
    </div>

    <div class="lob-grid lob-grid-2 lob-names">
      <${Field} label="Your name" error=${err('hostName')}>
        <input
          class="field"
          maxlength="20"
          autocomplete="nickname"
          placeholder="e.g. Maya"
          value=${name}
          aria-invalid=${!!err('hostName')}
          onInput=${(e) => setName(e.target.value)}
        />
      <//>
      <${Field} label="Game name" error=${err('gameName')}>
        <input class="field" maxlength="40" placeholder="Friday Night Game" value=${f.gameName} aria-invalid=${!!err('gameName')} onInput=${(e) => set('gameName', e.target.value)} />
      <//>
    </div>

    <div class="lob-f">
      ${!mobile && html`<span class="lob-f-label">Game</span>`}
      <${Seg} label="Game" options=${variantOptions} value=${f.variant} onChange=${(v) => set('variant', v)} />
    </div>

    <div class="lob-grid lob-grid-3">
      <${Field} label=${mobile ? 'SB' : 'Small blind'} error=${err('sb')}>${numInput('sb', 'Small blind', (v) => {
        sbEdited.current = true;
        set('sb', digits(v, 7));
      })}<//>
      <${Field} label=${mobile ? 'BB' : 'Big blind'} error=${err('bb')}>${numInput('bb', 'Big blind', setBB)}<//>
      <${Field} label="Seats">
        <${Select} label="Seats" options=${seatOptions} value=${f.seats} onChange=${(v) => set('seats', v)} />
      <//>
    </div>

    <div class="lob-buyins">
      <div class="lob-grid lob-grid-2">
        <${Field} label="Min buy-in" error=${err('minBuyIn')}>${numInput('minBuyIn', 'Min buy-in', (v) => {
          buyInsEdited.current = true;
          set('minBuyIn', digits(v));
        })}<//>
        <${Field} label="Max buy-in" error=${err('maxBuyIn')}>${numInput('maxBuyIn', 'Max buy-in', (v) => {
          buyInsEdited.current = true;
          set('maxBuyIn', digits(v));
        })}<//>
      </div>
      ${bbHint && html`<div class="muted lob-hint">${bbHint}</div>`}
    </div>

    <div class="lob-rows">
      <${Row} title="Host approves buy-ins" sub=${mobile ? 'Every buy-in goes on the ledger' : 'Every buy-in and rebuy goes on the ledger'}>
        <${Switch} label="Host approves buy-ins" checked=${f.approveBuyIns} onChange=${(v) => set('approveBuyIns', v)} />
      <//>
      <${Row} title=${mobile ? 'Run it more than once' : 'Allow running it more than once'} sub=${mobile ? 'All-in players vote on the runs' : 'All-in players vote to run the board 1, 2 or 3 times'} stack=${mobile}>
        <${Select} class="lob-select" label="Run it more than once" options=${RUN_OPTIONS} value=${f.maxRuns} onChange=${(v) => set('maxRuns', v)} />
      <//>
      <${Row} title=${mobile ? 'Reveal runout after a fold' : 'Reveal the runout after a fold'} sub="Show the cards that would have come" stack=${mobile}>
        <${Select} class="lob-select" label="Who can reveal" options=${REVEAL_OPTIONS} value=${f.revealRunout} onChange=${(v) => set('revealRunout', v)} />
      <//>
      <${Row} title="Losing hands at showdown" sub=${mobile ? 'All-in and called hands are always shown' : 'All-in and last-called hands are always shown'} stack=${mobile}>
        <${Select} class="lob-select" label="Losing hands at showdown" options=${LOSER_OPTIONS} value=${f.showdownLosers} onChange=${(v) => set('showdownLosers', v)} />
      <//>
      <${Row} title="Action timer" sub="Time to act before an automatic check or fold" stack=${mobile}>
        <${Select}
          class="lob-select"
          label="Action timer"
          options=${TIMER_OPTIONS.map((s) => ({ value: String(s), label: s + ' seconds' }))}
          value=${f.actionTime}
          onChange=${(v) => set('actionTime', v)}
        />
      <//>
    </div>

    <${Button} kind="primary" size="lg" type="submit" class="lob-submit" disabled=${busy}>
      ${busy ? 'Creating table…' : 'Create table'}
    <//>
  </form>`;
}

// ─── page ────────────────────────────────────────────────────────────────────

export function Lobby() {
  const mobile = useIsMobile();
  useEffect(() => {
    document.title = 'Felt — home game poker';
  }, []);

  if (mobile) {
    return html`<div class="lobby lobby-m">
      <header class="lob-head"><${Logo} size=${26} /></header>
      <div class="lob-hero-m">
        <h1 class="lob-title">Home game,<br />real table.</h1>
        <${HeroCards} mobile=${true} />
      </div>
      <${JoinBox} mobile=${true} />
      <${RecentGames} />
      <${CreateForm} mobile=${true} />
      <p class="muted lob-foot">No accounts, no downloads — share the room code and play.</p>
    </div>`;
  }

  return html`<div class="lobby">
    <div class="lob-wrap">
      <header class="lob-head">
        <${Logo} size=${30} />
        <span class="muted lob-head-note">Private tables · no sign-up</span>
      </header>
      <div class="lob-main">
        <div class="lob-left">
          <h1 class="lob-title">Home game,<br />real table.</h1>
          <p class="muted lob-lede">
            Deal a private game for your friends. The host handles buy-ins and chip counts; everyone gets a clean ledger and who-owes-who at the end.
          </p>
          <${HeroCards} />
          <${JoinBox} />
          <${RecentGames} />
        </div>
        <${CreateForm} />
      </div>
    </div>
  </div>`;
}
