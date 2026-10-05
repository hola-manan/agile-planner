// dev/stubs/ledger.js — TEMPORARY stand-in for public/js/ledger.js (preview harness only).
import { html } from '../../public/js/h.js';
import { useRoom } from '../../public/js/room.js';
import { fmt } from '../../public/js/ui.js';

export function Ledger() {
  const { view } = useRoom();
  const L = view.ledger;
  return html`<div><b>STUB LEDGER</b>
    ${L.players.map((p) => html`<div key=${p.pid} style=${{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #3A3A3A' }}><span>${p.name}</span><span class="mono">${fmt(p.net)}</span></div>`)}
  </div>`;
}
