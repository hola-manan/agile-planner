// dev/design-shim.js — renders design/*.dc.html mockups without the original canvas runtime.
//
// The mockups expect a `support.js` that understands <x-dc>, <helmet>, <sc-for>, <sc-if> and
// {{expressions}}, with values coming from `class Component extends DCLogic { renderVals() }` in a
// <script type="text/x-dc" data-props=…>. dev/design-shots.mjs serves this file in place of
// support.js so the mockups can be screenshotted next to the real app. Not deployed.
(function () {
  class DCLogic {
    constructor(props) {
      this.props = props || {};
    }
  }

  function evaluate(expr, scope) {
    try {
      // eslint-disable-next-line no-new-func
      return new Function('__s', 'with (__s) { return (' + expr + '); }')(scope);
    } catch (err) {
      console.warn('[design-shim] cannot evaluate {{' + expr + '}}:', err.message);
      return '';
    }
  }

  function interpolate(text, scope) {
    return String(text).replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
      const v = evaluate(e.trim(), scope);
      return v == null ? '' : String(v);
    });
  }

  const OPEN = /^\s*sc-(for|if)\s+([\s\S]*)$/;
  const attr = (src, name) => {
    const m = new RegExp(name + '="([^"]*)"').exec(src);
    return m ? m[1] : '';
  };
  const exprOf = (raw) => {
    const m = /^\{\{([\s\S]+)\}\}$/.exec(raw.trim());
    return m ? m[1].trim() : raw;
  };

  /** Render a list of sibling template nodes into new nodes for `scope`. */
  function renderList(nodes, scope) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 8) {
        const m = OPEN.exec(n.data);
        if (m) {
          // collect the block up to the matching close marker
          let depth = 1;
          let j = i + 1;
          for (; j < nodes.length; j++) {
            const c = nodes[j];
            if (c.nodeType !== 8) continue;
            if (OPEN.test(c.data)) depth++;
            else if (/^\s*\/sc-(for|if)\s*$/.test(c.data) && --depth === 0) break;
          }
          const body = nodes.slice(i + 1, j);
          if (m[1] === 'for') {
            const list = evaluate(exprOf(attr(m[2], 'list')), scope) || [];
            const as = attr(m[2], 'as') || 'item';
            list.forEach((item, idx) => out.push(...renderList(body, Object.assign(Object.create(scope), { [as]: item, $index: idx }))));
          } else if (evaluate(exprOf(attr(m[2], 'value')), scope)) {
            out.push(...renderList(body, scope));
          }
          i = j;
          continue;
        }
        if (/^\s*\/sc-/.test(n.data)) continue;
        continue; // drop ordinary comments
      }
      if (n.nodeType === 3) {
        out.push(document.createTextNode(interpolate(n.data, scope)));
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n.namespaceURI === 'http://www.w3.org/2000/svg' ? document.createElementNS(n.namespaceURI, n.localName) : document.createElement(n.localName);
      for (const a of Array.from(n.attributes)) {
        try {
          el.setAttribute(a.name, interpolate(a.value, scope));
        } catch {
          /* odd attribute name */
        }
      }
      const kids = n.localName === 'template' ? Array.from(n.content.childNodes) : Array.from(n.childNodes);
      for (const k of renderList(kids, scope)) el.appendChild(k);
      out.push(el);
    }
    return out;
  }

  async function run() {
    const raw = await (await fetch(location.href, { cache: 'no-store' })).text();
    const a = raw.indexOf('<x-dc>');
    const b = raw.lastIndexOf('</x-dc>');
    if (a < 0 || b < 0) return;
    let tpl = raw.slice(a + 6, b);
    // Template tags → comment markers, so they survive inside <table>/<tbody> (no foster parenting).
    tpl = tpl.replace(/<sc-(for|if)\b([^>]*)>/g, (_, k, rest) => '<!--sc-' + k + ' ' + rest.replace(/--/g, '- -') + '-->');
    tpl = tpl.replace(/<\/sc-(for|if)>/g, (_, k) => '<!--/sc-' + k + '-->');
    let helmet = '';
    tpl = tpl.replace(/<helmet>([\s\S]*?)<\/helmet>/, (_, h) => {
      helmet = h;
      return '';
    });

    const scriptEl = document.querySelector('script[type="text/x-dc"]');
    let vals = {};
    if (scriptEl) {
      let props = {};
      try {
        const spec = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
        for (const [k, v] of Object.entries(spec)) if (k[0] !== '$' && v && 'default' in v) props[k] = v.default;
      } catch {
        props = {};
      }
      try {
        // eslint-disable-next-line no-new-func
        const Component = new Function('DCLogic', scriptEl.textContent + '\n;return Component;')(DCLogic);
        vals = new Component(props).renderVals() || {};
      } catch (err) {
        console.warn('[design-shim] component failed:', err);
      }
    }

    const head = document.createElement('template');
    head.innerHTML = helmet;
    for (const n of Array.from(head.content.childNodes)) document.head.appendChild(n);

    const t = document.createElement('template');
    t.innerHTML = tpl;
    const nodes = renderList(Array.from(t.content.childNodes), Object.assign(Object.create(null), vals));
    const host = document.querySelector('x-dc');
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    if (host) host.replaceWith(frag);
    else document.body.appendChild(frag);
    document.documentElement.setAttribute('data-design-ready', '1');
  }

  window.DCLogic = DCLogic;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
