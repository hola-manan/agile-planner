// dev/stubs/actionbar.js — TEMPORARY stand-in for public/js/actionbar.js (preview harness only).
import { html } from '../../public/js/h.js';
import { useRoom } from '../../public/js/room.js';
import { Button } from '../../public/js/ui.js';

export function ActionBar({ onBuyIn, onLeave, onSit }) {
  const { view, act, isMobile } = useRoom();
  const me = view.me;
  const h = view.hand;
  const myTurn = me && h && h.toAct === me.id;
  return html`<div class="panel" style=${{ padding: '16px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', borderRadius: isMobile ? '0' : undefined }}>
    <b style=${{ flex: 1 }}>STUB ACTION BAR — ${!me ? 'visitor' : me.seat == null ? 'spectator' : me.away ? 'away' : me.busted ? 'busted' : myTurn ? 'your turn' : 'waiting'}</b>
    ${myTurn && html`<${Button} kind="danger" onClick=${() => act('act', { move: 'fold' })}>Fold<//><${Button} kind="primary" onClick=${() => act('act', { move: 'call' })}>Call<//>`}
    ${me && me.seat == null && html`<${Button} onClick=${() => onSit && onSit(null)}>Pick a seat<//>`}
    ${me && me.seat != null && html`<${Button} onClick=${onBuyIn}>Buy-in<//><${Button} kind="danger" onClick=${onLeave}>Leave<//>`}
  </div>`;
}
