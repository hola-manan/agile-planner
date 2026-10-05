// dev/stubs/table.js — TEMPORARY stand-in for public/js/table.js (preview harness only, ?stubs=…).
import { html } from '../../public/js/h.js';
import { useRoom } from '../../public/js/room.js';
import { Avatar, Card, fmt } from '../../public/js/ui.js';

export function Table({ onSit }) {
  const { view, isMobile } = useRoom();
  const h = view.hand;
  const board = h ? (h.runBoards.length ? h.runBoards[h.currentRun] || h.board : h.board) : [];
  return html`<div style=${{ padding: isMobile ? '24px 20px 40px' : '40px 80px 70px', height: isMobile ? '100%' : 'auto', boxSizing: 'border-box' }}>
    <div style=${{ position: 'relative', aspectRatio: isMobile ? 'auto' : '2.05 / 1', height: isMobile ? '100%' : 'auto', borderRadius: '999px', background: '#1C1C1C', padding: '14px', boxSizing: 'border-box' }}>
      <div style=${{ width: '100%', height: '100%', borderRadius: '999px', background: 'radial-gradient(ellipse at 50% 38%, #3DAA6E 0%, #1F8549 72%)', display: 'grid', placeItems: 'center', position: 'relative' }}>
        <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <span class="pill">STUB TABLE · Pot <span class="mono">${fmt(h ? h.potTotal : 0)}</span></span>
          <div style=${{ display: 'flex', gap: '6px' }}>${board.map((c) => html`<${Card} key=${c} card=${c} size=${isMobile ? 'sm' : 'md'} />`)}</div>
          <div style=${{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '90%' }}>
            ${view.seats.map((s) => {
              const p = view.players.find((x) => x.id === s.pid);
              return p
                ? html`<span key=${s.seat} class="pill"><${Avatar} name=${p.name} seed=${s.seat} size=${18} />${p.name} <span class="mono">${fmt(p.stack)}</span></span>`
                : html`<button key=${s.seat} class="pill" onClick=${() => onSit && onSit(s.seat)}>Sit ${s.seat + 1}</button>`;
            })}
          </div>
          ${view.me && view.me.hole && html`<div style=${{ display: 'flex', gap: '6px' }}>${view.me.hole.map((c) => html`<${Card} key=${c} card=${c} size="lg" />`)}</div>`}
        </div>
      </div>
    </div>
  </div>`;
}
