// dev/preview.js — UI preview harness (loaded by dev/preview.html after the import map is set up).
//
//   /dev/preview.html                                   index of fixtures
//   /dev/preview.html?fixture=allin-vote                the real RoomLayout with that view
//   /dev/preview.html?fixture=allin-vote&w=mobile       inside a 390×844 phone frame (on a wide screen)
//   …&open=ledger|host|log|chat|players                 open a panel/sheet on load
//   …&dialog=buyin|leave|menu|join|keys                 open a dialog on load
//   …&stubs=all | stubs=table,side                      force stub modules (missing ones are stubbed anyway)
//   /dev/preview.html?lobby=1                           the lobby
//   /__dev/preview.html?app=1  (dev server)               the whole App against the real API, stubs for missing modules
//
// Serve the repo root:  npx http-server /home/user/agile-planner -p 8790 -c-1  → http://127.0.0.1:8790/dev/preview.html
// (also works on the dev server at /__dev/preview.html)

const { PUB, DEV, stubbed = [] } = window.FELT_PREVIEW;
const q = new URLSearchParams(location.search);

const [{ html, ReactDOM, useState, useMemo, useCallback }, { RoomContext }, { RoomLayout, App }, { Lobby }, ui, fx] = await Promise.all([
  import(PUB + 'js/h.js'),
  import(PUB + 'js/room.js'),
  import(PUB + 'js/main.js'),
  import(PUB + 'js/lobby.js'),
  import(PUB + 'js/ui.js'),
  import(DEV + 'fixtures/index.js'),
]);
const { Toasts, toast } = ui;

const root = ReactDOM.createRoot(document.getElementById('preview-root'));

function selfUrl(params) {
  const u = new URLSearchParams(params);
  return location.pathname + '?' + u.toString();
}

function Bar({ name }) {
  const mobileHref = selfUrl({ ...Object.fromEntries(q), w: 'mobile' });
  const deskHref = selfUrl(Object.fromEntries([...q].filter(([k]) => k !== 'w' && k !== 'embed')));
  return html`<div class="pv-bar">
    <a href=${location.pathname}>All fixtures</a>
    ${name && html`<span>${name}${stubbed.length ? ' · stubs: ' + stubbed.join(',') : ''}</span>`}
    <a href=${deskHref} target="_top">Desktop</a>
    <a href=${mobileHref} target="_top">Phone</a>
  </div>`;
}

function Index({ list }) {
  return html`<div class="pv-index">
    <h1>Felt UI preview</h1>
    <p>
      Every fixture is a real <code>viewFor()</code> output from a game scripted with the engine (<code>node dev/make-fixtures.mjs</code>).
      ${stubbed.length ? html`<br />Stubbed modules (not written yet): <b>${stubbed.join(', ')}</b>.` : ''}
    </p>
    <div class="pv-list">
      <div class="pv-item">
        <b>Lobby</b><span>Create a game / join by code / your games.</span>
        <div class="pv-links"><a href=${selfUrl({ lobby: 1 })}>Desktop</a><a href=${selfUrl({ lobby: 1, w: 'mobile' })}>Phone</a></div>
      </div>
      ${list.map(
        (f) => html`<div class="pv-item" key=${f.name}>
          <b>${f.title}</b><span>${f.description}</span>
          <div class="pv-links">
            <a href=${selfUrl({ fixture: f.name })}>Desktop</a>
            <a href=${selfUrl({ fixture: f.name, w: 'mobile' })}>Phone</a>
            <a href=${selfUrl({ fixture: f.name, open: 'ledger' })}>Ledger</a>
            ${f.name.startsWith('host') && html`<a href=${selfUrl({ fixture: f.name, open: 'host' })}>Host tools</a>`}
          </div>
        </div>`,
      )}
    </div>
  </div>`;
}

/** Fake room: the fixture view + an act() that only reports what would have been sent. */
function PreviewRoom({ fixture }) {
  const [view, setView] = useState(() => fx.freshen(fixture.view));
  const act = useCallback(async (type, args = {}) => {
    if (type !== 'tick') toast('Preview — would send ' + type + (Object.keys(args).length ? ' ' + JSON.stringify(args) : ''), 'default');
    return null;
  }, []);
  const join = useCallback(async (name) => {
    toast('Preview — would join as “' + name + '”', 'default');
    return null;
  }, []);
  const room = useMemo(
    () => ({
      code: view.code,
      view,
      error: null,
      loading: false,
      act,
      refresh: async () => setView(fx.freshen(fixture.view)),
      joined: !!view.me,
      join,
      session: view.me ? { pid: view.me.id, token: 'preview' } : null,
      acting: false,
    }),
    [view, act, join, fixture],
  );
  return html`<${RoomContext.Provider} value=${room}>
    <${RoomLayout} initialPanel=${q.get('open')} initialDialog=${q.get('dialog')} />
  <//>`;
}

function render(node, name) {
  root.render(html`${node}<${Toasts} />${q.get('embed') ? null : html`<${Bar} name=${name} />`}`);
}

async function main() {
  // Phone frame on a wide screen: the iframe renders the same URL at 390 px.
  if (q.get('w') === 'mobile' && !q.get('embed') && window.innerWidth >= 600) {
    const src = selfUrl({ ...Object.fromEntries(q), embed: 1 });
    render(html`<div class="pv-frame-wrap"><iframe class="pv-frame" src=${src} title="Phone preview"></iframe></div>`, q.get('fixture') || 'lobby');
    return;
  }
  if (q.get('app')) {
    // The whole App against the real API (use on the dev server: /__dev/preview.html?app=1), with
    // any UI modules that don't exist yet stubbed. Navigation leaves this URL — reload goes to /.
    root.render(html`<${App} />`);
    return;
  }
  if (q.get('lobby')) {
    render(html`<${Lobby} />`, 'lobby');
    return;
  }
  const name = q.get('fixture');
  if (!name) {
    render(html`<${Index} list=${await fx.listFixtures()} />`);
    return;
  }
  const f = await fx.loadFixture(name);
  document.title = f.title + ' · Felt preview';
  render(html`<${PreviewRoom} fixture=${f} />`, name);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('preview-root').innerHTML = '<div class="pv-err"></div>';
  document.querySelector('.pv-err').textContent = String((err && err.stack) || err);
});
