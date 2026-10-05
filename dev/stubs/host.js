// dev/stubs/host.js — TEMPORARY stand-in for public/js/host.js (preview harness only).
import { html } from '../../public/js/h.js';
import { useRoom } from '../../public/js/room.js';

export function HostTools() {
  const { view } = useRoom();
  return html`<div><b>STUB HOST TOOLS</b><pre style=${{ fontSize: '12px' }}>${JSON.stringify(view.requests, null, 2)}</pre></div>`;
}
