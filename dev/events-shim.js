/* Local dev stand-in for Hatchable's /__hatchable/events.js (served by dev/server.mjs).
 *
 * Same browser contract as the platform lib:
 *   const conn = hatchable.events.connect({ authUrl: '/api/events-token?code=ABC-1234' });
 *   conn.channel('room:ABC-1234').on('update', (ev) => { ev.id, ev.channel, ev.event, ev.data });
 *   conn.channel('room:ABC-1234').on('$reset', () => refetchSnapshot());
 *   .on('*', cb) receives every event; .off(event, cb); conn.close().
 *
 * Transport: one EventSource per channel against /__dev/sse?channel=…&token=… . The token comes
 * from authUrl (your events-token route → events.grant). Native EventSource reconnects replay
 * missed events via Last-Event-ID; if the server refuses (expired token, restart) the shim fetches a
 * fresh token and reconnects with backoff. When events can't be replayed the server sends `$reset`.
 */
(function () {
  'use strict';
  var root = (window.hatchable = window.hatchable || {});
  if (root.events && root.events.__dev !== true && root.events.connect) return;

  var DEFAULT_AUTH_URL = '/api/events-token';
  var SSE_URL = '/__dev/sse';

  function Channel(conn, name) {
    this.conn = conn;
    this.name = name;
    this.handlers = Object.create(null); // event → Set<fn>
    this.es = null;
    this.lastId = null;
    this.attempt = 0;
    this.timer = null;
    this.closed = false;
    this.opening = false;
  }

  Channel.prototype.on = function (event, cb) {
    if (typeof cb !== 'function') throw new TypeError('channel.on(event, callback): callback must be a function');
    (this.handlers[event] || (this.handlers[event] = new Set())).add(cb);
    return this;
  };

  Channel.prototype.off = function (event, cb) {
    var set = this.handlers[event];
    if (set) {
      if (cb) set.delete(cb);
      else set.clear();
    }
    return this;
  };

  Channel.prototype.dispatch = function (ev) {
    var lists = [this.handlers[ev.event], this.handlers['*']];
    for (var i = 0; i < lists.length; i++) {
      if (!lists[i]) continue;
      lists[i].forEach(function (cb) {
        try {
          cb(ev);
        } catch (err) {
          console.error('[hatchable.events] handler error', err);
        }
      });
    }
  };

  Channel.prototype.scheduleReopen = function () {
    if (this.closed || this.timer) return;
    var self = this;
    var delay = Math.min(30000, 1000 * Math.pow(2, this.attempt)) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.timer = setTimeout(function () {
      self.timer = null;
      self.open();
    }, delay);
  };

  Channel.prototype.open = function () {
    if (this.closed || this.opening) return;
    var self = this;
    this.opening = true;
    fetch(this.conn.authUrl, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('token route returned ' + r.status);
        return r.json();
      })
      .then(function (grant) {
        self.opening = false;
        if (self.closed) return;
        if (!grant || !grant.token) throw new Error('token route returned no token');
        if (Array.isArray(grant.channels) && grant.channels.indexOf(self.name) < 0) {
          throw new Error('token does not grant channel ' + self.name);
        }
        var url = SSE_URL + '?channel=' + encodeURIComponent(self.name) + '&token=' + encodeURIComponent(grant.token);
        if (self.lastId != null) url += '&lastEventId=' + encodeURIComponent(self.lastId);
        var es = new EventSource(url);
        self.es = es;
        es.onopen = function () {
          self.attempt = 0;
        };
        es.onmessage = function (e) {
          var ev;
          try {
            ev = JSON.parse(e.data);
          } catch (err) {
            return;
          }
          if (e.lastEventId) self.lastId = e.lastEventId;
          self.dispatch(ev);
        };
        es.onerror = function () {
          // CONNECTING = the browser is retrying by itself (Last-Event-ID replay). CLOSED = refused.
          if (es.readyState === 2) {
            es.close();
            if (self.es === es) self.es = null;
            self.scheduleReopen();
          }
        };
      })
      .catch(function (err) {
        self.opening = false;
        if (self.closed) return;
        console.warn('[hatchable.events] ' + self.name + ': ' + (err && err.message ? err.message : err));
        self.scheduleReopen();
      });
  };

  Channel.prototype.close = function () {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.es) this.es.close();
    this.es = null;
  };

  function Connection(opts) {
    this.authUrl = (opts && opts.authUrl) || DEFAULT_AUTH_URL;
    this.channels = Object.create(null);
  }

  Connection.prototype.channel = function (name) {
    var ch = this.channels[name];
    if (!ch) {
      ch = this.channels[name] = new Channel(this, name);
      ch.open();
    }
    return ch;
  };

  Connection.prototype.close = function () {
    for (var k in this.channels) this.channels[k].close();
    this.channels = Object.create(null);
  };

  root.events = {
    __dev: true,
    connect: function (opts) {
      return new Connection(opts || {});
    },
  };
})();
