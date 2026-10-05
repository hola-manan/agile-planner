// dev/stubs/side.js — TEMPORARY stand-in for public/js/side.js (preview harness only).
import { html } from '../../public/js/h.js';
import { useRoom } from '../../public/js/room.js';
import { Button } from '../../public/js/ui.js';

export function HandLog() {
  const { view } = useRoom();
  const log = (view.hand && view.hand.log) || (view.lastHand && view.lastHand.log) || [];
  return html`<div>${log.map((l, i) => html`<div key=${i} style=${{ padding: '6px 0', borderBottom: '1px solid #3A3A3A', fontSize: '14px' }}>${l.name || ''} ${l.text} <span class="mono">${l.amount ?? ''}</span></div>`)}</div>`;
}
export function Chat() {
  const { view } = useRoom();
  return html`<div>${view.chat.map((c) => html`<div key=${c.id} style=${{ padding: '4px 0' }}><b>${c.name}</b> ${c.text}</div>`)}</div>`;
}
export function PlayersList() {
  const { view } = useRoom();
  return html`<div>${view.players.map((p) => html`<div key=${p.id} style=${{ padding: '4px 0' }}>${p.name} <span class="mono muted">${p.stack}</span></div>`)}</div>`;
}
export function SessionBox({ onBuyIn, onLeave }) {
  return html`<div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}><${Button} onClick=${onBuyIn}>Request a buy-in<//><${Button} kind="danger" onClick=${onLeave}>Leave seat<//></div>`;
}
export function SidePanel({ onBuyIn, onLeave }) {
  return html`<div class="panel" style=${{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <b>STUB SIDE PANEL</b><${HandLog} /><${SessionBox} onBuyIn=${onBuyIn} onLeave=${onLeave} />
  </div>`;
}
