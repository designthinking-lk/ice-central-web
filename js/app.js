/* ICE — single-file application: hash router + views.
 * No framework: template strings + event delegation.
 * Multi-project: A.getProject() names the active project; per-project
 * branding arrives in bootstrap (state.data.project) and every project-scoped
 * localStorage key carries the project slug. */
(function () {
  'use strict';

  var C = window.ICE_CONFIG;
  var A = window.IceApi;

  var state = {
    data: null,       // bootstrap payload
    loaded: false,    // fresh data arrived
    q: '',            // directory search
    roleFilter: 'all',
    skillFilter: null,
    teamFilter: null, // active team highlight on the People hive (team id or null)
    renderedSig: null, // signature of the data the current view was built from
  };

  // ------------------------------------------------------------- utilities

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function timeAgo(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return fmtDate(iso);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  function avatar(user, cls) {
    cls = 'avatar ' + (cls || '');
    if (user && user.image) {
      return '<img class="' + cls + '" src="' + esc(user.image) + '" alt="" loading="lazy" ' +
             'onerror="this.outerHTML=window.__avFallback(' + esc(JSON.stringify(initials(user.name))) + ',' + JSON.stringify(cls) + ')">';
    }
    return window.__avFallback(initials(user && user.name), cls);
  }
  window.__avFallback = function (init, cls) {
    return '<span class="' + esc(cls) + ' avatar-fallback">' + esc(init || '?') + '</span>';
  };

  function toast(msg, isError) {
    var t = $('#toast');
    t.className = 'toast' + (isError ? ' error' : '');
    t.innerHTML = '<i class="fa-solid ' + (isError ? 'fa-circle-exclamation' : 'fa-circle-check') + '"></i>' + esc(msg);
    t.hidden = false;
    clearTimeout(t.__timer);
    t.__timer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function modal(html) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><div class="modal" onclick="event.stopPropagation()">' + html + '</div></div>';
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }

  function busy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('loading', !!on);
    btn.disabled = !!on;
  }

  function me() { return state.data && state.data.me; }
  function signedIn() { return !!A.getToken(); }

  // ---- "Highlight mine" ----
  // A global, view-spanning toggle that makes MY team chip, MY project card and
  // MY skills glow wherever they appear. It never filters or hides anything —
  // it only emphasises, so "All" and "Mine" show the same content. Mine
  // elements are tagged `.is-mine` at render time (always); the toggle just
  // flips `body.mine-on`, which is what CSS keys the glow off — so switching is
  // instant and needs no re-render.
  var MINE_KEY = 'ice.mineHi';
  var _mySkillSet = null, _mySkillKey = null;
  function mySkills() {
    var arr = (me() && me().skills) || [];
    var key = arr.join('');
    if (key !== _mySkillKey) {
      _mySkillKey = key; _mySkillSet = Object.create(null);
      arr.forEach(function (s) { _mySkillSet[String(s || '').trim().toLowerCase()] = 1; });
    }
    return _mySkillSet;
  }
  function isMySkill(s) { return !!mySkills()[String(s || '').trim().toLowerCase()]; }
  function mineOn() { return document.body.classList.contains('mine-on'); }
  function setMine(on) {
    document.body.classList.toggle('mine-on', !!on);
    try { localStorage.setItem(MINE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    var btn = $('#mineToggle');
    if (btn) { btn.classList.toggle('is-on', !!on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }

  // ---- roles ----
  // users.role can hold up to 2 comma-separated roles: 'admin' plus one of the
  // mutually-exclusive "track" roles 'participant'/'mentor'/'catalyst' (only one
  // of the three). 'none' = every role removed — the person keeps their data but
  // gets the visitor view until a role comes back. Blank/legacy counts as
  // participant. Mirrors rolesOf_ in the backend. A catalyst is a special guest
  // (they "spark" the program) — shown on the ICE letter formation in reserved
  // slots, but never on a team or project, and with no platform powers.
  var PLATFORM_ROLES = ['admin', 'participant', 'mentor', 'catalyst'];
  var TRACK_ROLES = ['participant', 'mentor', 'catalyst']; // at most one of these
  function rolesOf(u) {
    if (!u) return [];
    var raw = String(u.role || '').trim().toLowerCase();
    if (raw === 'none') return [];
    if (!raw) return ['participant'];
    var out = [];
    raw.split(',').forEach(function (r) {
      r = r.trim();
      if (PLATFORM_ROLES.indexOf(r) !== -1 && out.indexOf(r) === -1) out.push(r);
    });
    return out.length ? out : ['participant'];
  }
  function hasRoleU(u, role) { return rolesOf(u).indexOf(role) !== -1; }
  function hasAccess(u) { return rolesOf(u).length > 0; }
  // A member = a role-holding registered user, or a global admin. Members-only
  // surfaces (Program, Tools) gate on this, not merely on being signed in.
  function isMember() { return !!(state.data && (state.data.isAdmin || (me() && hasAccess(me())))); }
  // On a team / owns a project — only participants and mentors. Admin-only and
  // catalyst-only accounts stay out of teams and project rosters.
  function isCommunityMember(u) { return hasRoleU(u, 'participant') || hasRoleU(u, 'mentor'); }
  // Catalysts DO appear on the ICE letter hive (in reserved slots), alongside
  // community members.
  function isCatalyst(u) { return hasRoleU(u, 'catalyst'); }
  function isOnHive(u) { return isCommunityMember(u) || isCatalyst(u); }
  // Roles an admin can still add to this person (max 2; participant/mentor/
  // catalyst are mutually exclusive).
  function addableRoles(u) {
    var roles = rolesOf(u);
    if (roles.length >= 2) return [];
    var out = [];
    if (roles.indexOf('admin') === -1) out.push('admin');
    if (!roles.some(function (r) { return TRACK_ROLES.indexOf(r) !== -1; })) out.push('participant', 'mentor', 'catalyst');
    return out;
  }

  // ---- day / night theme ----
  // data-theme on <html> (also set pre-paint by an inline snippet in
  // index.html); persisted as ice.theme.
  // animate: cross-fade the switch via .theme-fade (theme.css); off at boot
  // so the initial paint stays instant.
  var themeFadeTimer = null;
  function applyTheme(dark, animate) {
    var root = document.documentElement;
    if (animate) {
      root.classList.add('theme-fade');
      clearTimeout(themeFadeTimer);
      themeFadeTimer = setTimeout(function () { root.classList.remove('theme-fade'); }, 450);
    }
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    var btn = $('#themeToggle');
    if (btn) {
      btn.innerHTML = '<i class="fa-solid ' + (dark ? 'fa-sun' : 'fa-moon') + '"></i>';
      btn.title = dark ? 'Day mode' : 'Night mode';
    }
  }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  // Per-project branding from bootstrap; config values are only the
  // pre-bootstrap fallback shown before the first payload arrives.
  function proj() { return (state.data && state.data.project) || {}; }
  // The registry `tagline` column holds the full workshop title (e.g.
  // "Apple Pears Pineapple 2028" / "Innovation Creativity Entrepreneurship 2026");
  // the short brand form (APP2028 / ICE2026) is DERIVED from it. `name` stays the
  // short slug/id and is only a fallback here.
  function fullTitle() { return proj().tagline || proj().name || C.EVENT_NAME; }
  // Split a title into alphabetic words + a trailing year. Handles a glued
  // single token too ("ICE2026" -> {words:["ICE"], year:"2026"}).
  function parseTitle(title) {
    var tokens = String(title || '').trim().split(/\s+/).filter(Boolean);
    var year = '';
    if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) year = tokens.pop();
    if (tokens.length === 1 && !year) {
      var m = tokens[0].match(/^([A-Za-z].*?)(\d+)$/);
      if (m) { tokens = [m[1]]; year = m[2]; }
    }
    return { words: tokens, year: year };
  }
  // "Apple Pears Pineapple 2028" -> "APP2028"; a single word is used as-is.
  function shortName(title) {
    var p = parseTitle(title);
    var acr = p.words.length >= 2
      ? p.words.map(function (s) { return s.charAt(0).toUpperCase(); }).join('')
      : (p.words[0] || '').toUpperCase();
    return acr + p.year;
  }
  // Everywhere the brand appears as plain text uses the short form.
  function eventName() { return shortName(fullTitle()); }
  function eventTagline() { return proj().tagline || C.EVENT_TAGLINE; }
  function siteUrl() { return proj().siteUrl || location.host; }
  // Shareable social-card permalink (served by the card.designthinking.lk Worker,
  // which renders per-member/project OG tags then bounces into the app).
  function shareCardUrl(kind, id) {
    return 'https://card.designthinking.lk/' + kind + '/' + encodeURIComponent(id) + '?project=' + encodeURIComponent(A.getProject());
  }
  // Copy a share link to the clipboard and confirm with a toast; falls back to a
  // prompt where the async clipboard API is unavailable/blocked.
  function copyShareLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(function () { toast('Link copied'); })
        .catch(function () { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
  }

  // Where the current workshop sits in time — 'before' | 'during' | 'after' —
  // read off the project's start/end dates (local wall-clock, so it flips at
  // the same moment for every viewer). No dates set → treat as done.
  function workshopPhase() {
    var p = proj();
    var s = p.startDate, e = p.endDate || p.startDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return 'after';
    var n = new Date();
    var today = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') +
      '-' + String(n.getDate()).padStart(2, '0');
    return today < s ? 'before' : today > e ? 'after' : 'during';
  }
  // A tiny word that shifts with the workshop's tense, coloured apart from the
  // sentence around it — e.g. tense('to be', 'being', 'were') so a line reads
  // true whether the workshop is upcoming, live, or over.
  function tense(before, during, after) {
    var phase = workshopPhase();
    var word = phase === 'before' ? before : phase === 'during' ? during : after;
    return '<span class="tense">' + word + '</span>';
  }

  // "ICE2026" renders as ICE + emphasised year wherever the brand is shown.
  function brandHtml(bold) {
    var m = String(eventName()).match(/^([A-Za-z]+)(\d+)$/);
    var tagOpen = bold ? '<b>' : '<span class="brand-year">';
    var tagClose = bold ? '</b>' : '</span>';
    return m ? esc(m[1]) + tagOpen + esc(m[2]) + tagClose : esc(eventName());
  }

  // ---- animated sidebar brand: ICE#### ⇄ "Innovation Creativity Entrepreneurship ####"
  // The lowercase letters of each word spawn below their capital and glide up,
  // one rank per word in parallel (ICE → InCrEn → InnCreEnt → …), the phrase
  // widening as they land. Fully-closed and fully-open states hold for 8 s.
  var BRAND_HOLD = 8000, BRAND_STEP = 90;
  var brandTimers = [];

  function renderBrand(el) {
    var parsed = parseTitle(fullTitle());
    var brandWords = parsed.words, brandYear = parsed.year;
    var key = fullTitle();
    // Single-word titles (or reduced motion) render the static short form —
    // there's nothing to expand to.
    if (brandWords.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      brandTimers.forEach(clearTimeout); brandTimers = [];
      el.removeAttribute('data-anim');
      el.innerHTML = brandHtml(false);
      return;
    }
    if (el.getAttribute('data-anim') === key) return; // loop already running for this project
    el.setAttribute('data-anim', key);
    var html = '';
    brandWords.forEach(function (w) {
      html += '<span class="bw">' + esc(w.charAt(0).toUpperCase());
      for (var i = 1; i < w.length; i++) html += '<span class="bl">' + esc(w.charAt(i)) + '</span>';
      html += '</span>';
    });
    if (brandYear) html += '<span class="brand-year">' + esc(brandYear) + '</span>';
    el.innerHTML = html;
    var words = [].map.call(el.querySelectorAll('.bw'), function (w) {
      return [].slice.call(w.querySelectorAll('.bl'));
    });
    var maxLen = Math.max.apply(null, words.map(function (a) { return a.length; }));
    brandTimers.forEach(clearTimeout); brandTimers = [];
    function later(fn, ms) { brandTimers.push(setTimeout(fn, ms)); }
    function setRank(n) { // letters whose rank is below n are shown
      words.forEach(function (arr) {
        arr.forEach(function (sp, i) { sp.classList.toggle('on', i < n); });
      });
      el.classList.toggle('open', n > 0);
    }
    function expand(n) {
      setRank(n);
      if (n < maxLen) later(function () { expand(n + 1); }, BRAND_STEP);
      else later(function () { collapse(maxLen - 1); }, BRAND_HOLD);
    }
    function collapse(n) {
      setRank(n);
      if (n > 0) later(function () { collapse(n - 1); }, BRAND_STEP);
      else later(function () { expand(1); }, BRAND_HOLD);
    }
    // start in the fully-expanded state, hold, then breathe closed and loop
    setRank(maxLen);
    later(function () { collapse(maxLen - 1); }, BRAND_HOLD);
  }
  function isMentor() { return hasRoleU(me(), 'mentor'); }
  // Mentors and admins may post announcements.
  function canAnnounce() { return !!(state.data && (state.data.isAdmin || isMentor())); }

  function userById(id) {
    var users = (state.data && state.data.users) || [];
    for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
    return null;
  }

  // --------------------------------------------------------------- data

  // A background refresh must never blow away live, ephemeral DOM state the
  // user is mid-interaction with — a full route() would un-flip the project
  // stack, restart a playing intro video, or wipe an unsaved photo preview.
  function viewBusy() {
    if ($('#profileForm')) return true;      // profile editor (card flip, photo preview, video)
    if (projSel != null) return true;         // a project card is open / being flipped
    if ($('#toolFormSlot') && $('#toolFormSlot').children.length) return true; // tool add/edit form open
    if (teamEditing) return true;             // inline team edit in progress
    var view = $('#view');
    if (view && view.querySelector('video, iframe[src*="youtu"]')) return true; // an intro video is on screen
    return false;
  }

  // Signature of the payload for change-detection, EXCLUDING volatile fields
  // that change on every fetch: `online` (presence — the backend even marks US
  // online as a side effect of the call) and `unread`. Without this exclusion a
  // plain reload always looks "changed", so the boot background refresh would
  // re-render the whole view ~3s in — a visible flash for no reason. Those two
  // fields are reflected without a re-render: `unread` via renderChrome's chat
  // badge, presence via refreshPresenceDots.
  function dataSig(d) {
    if (!d) return '';
    try {
      return JSON.stringify(d, function (k, v) {
        return (k === 'online' || k === 'unread') ? undefined : v;
      });
    } catch (e) { return ''; }
  }

  // Update the People hive's online dots in place (cheap, no re-render) so
  // presence stays fresh even when a background refresh brings no structural
  // change and therefore skips route().
  function refreshPresenceDots() {
    var word = $('#word');
    if (!word) return;
    var online = (state.data && state.data.online) || [];
    $all('.oct[data-uid]', word).forEach(function (el) {
      var isOn = online.indexOf(el.getAttribute('data-uid')) !== -1;
      var dot = el.querySelector('.oct-online');
      if (isOn && !dot) {
        var s = document.createElement('span');
        s.className = 'oct-online'; s.title = 'Online';
        el.appendChild(s);
      } else if (!isOn && dot) {
        dot.remove();
      }
      el.title = (el.title || '').replace(/ — online$/, '') + (isOn ? ' — online' : '');
    });
  }

  // opts.background = true: data-only refresh (chrome updates, but the view is
  // only re-rendered when it's safe — never mid-interaction, and never when the
  // fresh data is structurally identical to what's already on screen). User-
  // triggered refreshes (after a save, etc.) pass nothing and always re-render.
  async function refresh(opts) {
    opts = opts || {};
    try {
      var hadData = !!state.data;
      var data = await A.api('bootstrap');
      state.data = data;
      state.loaded = true;
      A.writeCache(data);
      renderChrome();
      // First paint (no prior data) or an explicit refresh → always render.
      // A background refresh only re-renders when the payload STRUCTURALLY
      // changed (new/edited people, teams, projects…) and the view isn't busy;
      // otherwise it just updates the decorative presence dots in place. This
      // is what stops the one-off view repaint a few seconds after every load.
      if (!opts.background || !hadData) {
        route();
      } else if (dataSig(data) !== state.renderedSig && !viewBusy()) {
        route();
      } else {
        refreshPresenceDots();
      }
    } catch (err) {
      // A stale/deleted project selection must not brick the app — fall back
      // to the default project once.
      if (err.code === 'unknown_project' && A.getProject() !== C.DEFAULT_PROJECT) {
        A.setProject(C.DEFAULT_PROJECT);
        state.data = A.readCache();
        return refresh();
      }
      if (!state.data) {
        $('#view').innerHTML = '<div class="empty"><i class="fa-solid fa-plug-circle-xmark"></i>' +
          'Could not reach the ' + esc(eventName()) + ' server.<br>' + esc(err.message || '') +
          '<br><br><button class="btn btn-outline" onclick="location.reload()">Retry</button></div>';
      } else {
        toast('Could not refresh data: ' + (err.message || 'network error'), true);
      }
    }
  }

  // --------------------------------------------------------------- chrome

  function renderChrome() {
    var d = state.data || {};
    // Sidebar brand follows the active project's name.
    var brandName = $('.brand-name');
    if (brandName) renderBrand(brandName);
    renderProjectSwitcher(d);
    var actions = $('#topbarActions');
    // People & Projects are public; Program & Tools need sign-in; Admin only for admins.
    var loggedIn = signedIn();
    var navTools = $('#navTools');
    var navProgram = $('#navProgram');
    var navAdmin = $('#navAdmin');
    // A registered member whose every role was removed gets the visitor
    // chrome (no member nav) — only the avatar menu remains, to sign out.
    var noRole = !!(d.me && !hasAccess(d.me));
    // Program & Tools are members-only (not merely "signed in") — a signed-in but
    // un-invited account must not see them. Admins and role-holders pass.
    var canMember = !!d.isAdmin || (!!d.me && hasAccess(d.me));
    if (navTools) navTools.hidden = !canMember;
    if (navProgram) navProgram.hidden = !canMember;
    if (navAdmin) navAdmin.hidden = !d.isAdmin;
    // Un-invited signed-in accounts are locked to the switch-account gate: hide
    // the sidebar nav and floating tools so nothing members-only is reachable.
    document.body.classList.toggle('access-locked', isLockedOut());
    // "Highlight mine" toggle: a member-only affordance — only meaningful once
    // there's something of mine to glow (a team or my own skills). Keep its
    // pressed state in sync with the persisted body.mine-on class.
    var mineBtn = $('#mineToggle');
    if (mineBtn) {
      var canMine = loggedIn && !!d.me && !noRole && (!!myTeam() || (d.me.skills || []).length > 0);
      mineBtn.hidden = !canMine;
      mineBtn.classList.toggle('is-on', mineOn());
      mineBtn.setAttribute('aria-pressed', mineOn() ? 'true' : 'false');
      if (!canMine && mineOn()) setMine(false); // never leave the glow stuck on for a non-member
    }
    if (signedIn() && d.me) {
      actions.innerHTML =
        (noRole ? '<span class="topbar-norole" title="Your account has no assigned role — contact an organizer to restore access. Your data is safe."><i class="fa-solid fa-circle-info"></i>No role assigned</span>' : '') +
        '<button class="avatar-circle-btn" data-action="user-menu" aria-label="Account" title="' + esc(d.me.name) + '">' +
        avatar(d.me, 'avatar-sm') + '</button>';
    } else if (signedIn()) {
      // Until the first fresh bootstrap confirms this person is NOT registered,
      // show no CTA — a registered member must never see it flash at boot.
      // The CTA is redundant while they're already on the registration card, so
      // it's hidden there; on every other view it stays (gently pulsing to draw
      // the eye) until the profile is complete.
      var onRegister = /^#\/register\b/.test(location.hash || '');
      actions.innerHTML =
        (state.loaded && !onRegister ? '<a class="btn btn-gradient btn-sm cta-pulse" href="#/register"><i class="fa-regular fa-id-card"></i>Complete registration</a>' : '') +
        '<button class="avatar-circle-btn" data-action="guest-menu" aria-label="Account" title="Account">' +
        '<span class="avatar-guest"><i class="fa-solid fa-user"></i></span></button>';
    } else {
      actions.innerHTML = '<button class="btn btn-primary btn-sm" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in</button>';
    }
    // public-view footer: credit + sponsor logos, only while signed out
    var credit = $('#siteCredit');
    if (credit) credit.hidden = loggedIn;
    // chat & broadcasts pane — for registered participants (DMs need a
    // workshop account). Hide the sidebar button + force-close otherwise.
    var chatBtn = $('#navChatBtn');
    var showChat = chatEnabled() && signedIn() && !!d.me && !noRole;
    if (chatBtn) chatBtn.hidden = !showChat;
    if (!showChat) {
      var pane = $('#chatpane');
      if (pane && !pane.hidden) { pane.hidden = true; document.body.classList.remove('chat-open'); }
    } else {
      chatAutoConnect();   // silently restore the Chat token if granted before
      renderChatPane();
      if (localStorage.getItem(chatKey()) === 'open' && $('#chatpane') && $('#chatpane').hidden) {
        $('#chatpane').hidden = false;
        document.body.classList.add('chat-open');
      }
    }
    // app-bar context blocks (right-aligned): People gets the legend + team
    // count + chips; Projects gets the crafted-by tagline.
    var isPeople = /^#\/people$/.test(location.hash || '#/');
    var isProjects = /^#\/projects$/.test(location.hash || '#/');
    var tb = $('#topbarTeams');
    if (tb) {
      var chips = '';
      if (isPeople) {
        var nTeams = homeTeams().length;
        chips = topbarLegendHtml() +
          '<span class="topbar-count">' + nTeams + ' team' + (nTeams === 1 ? '' : 's') + '</span>' +
          teamChipsHtml();
      } else if (isProjects) {
        var nT = homeTeams().length;
        chips = '<span class="topbar-tag">' + DEMO_PROJECTS.length + ' amazing projects ' +
          tense('to be', 'being', 'were') + ' crafted in 3 days by ' +
          nT + ' amazing teams</span>';
      }
      if (tb.innerHTML !== chips) tb.innerHTML = chips;
    }
    // on People, the hive goes full-bleed over the rail (letters above the
    // half octagon; the I's cavity hosts the nav)
    document.body.classList.toggle('hive-full', isPeople);
    // landing: chrome floats transparent over the full-screen feature video
    document.body.classList.toggle('landing-bg', /^#\/?$/.test(location.hash || '#/'));
    // active nav
    var hash = location.hash || '#/';
    $all('#nav a, .fab-stack a').forEach(function (a) {
      var key = a.getAttribute('data-nav');
      var on = (key === 'people' && hash.indexOf('#/profile') === 0) ||
               hash.indexOf('#/' + key) === 0 ||
               (key === 'teams' && hash.indexOf('#/team/') === 0);
      a.classList.toggle('active', !!on);
    });
  }

  // Workshop switcher — a circle button sitting just before the animated brand.
  // Opening it hides the title and lists every visible project by its full
  // registry name; picking one switches (a full redirect to that subdomain in
  // production). Hidden entirely until bootstrap lists more than one project.
  var brandMenuOpen = false;
  function renderProjectSwitcher(d) {
    var sw = $('#brandSwitch'), menu = $('#brandMenu'), brand = $('#brand');
    if (!sw || !menu || !brand) return;
    var projects = (d && d.projects) || [];
    // Admins only, and only when there's more than one project to switch to.
    if (!d || !d.isAdmin || projects.length < 2) {
      sw.hidden = true; menu.hidden = true; brandMenuOpen = false;
      brand.classList.remove('menu-open');
      return;
    }
    sw.hidden = false;
    var current = A.getProject();
    menu.innerHTML = projects.map(function (p) {
      return '<button class="brand-opt' + (p.id === current ? ' current' : '') + '" type="button" data-action="brand-pick" data-proj="' + esc(p.id) + '">' +
        '<span class="brand-opt-name">' + esc(p.tagline || p.name) + '</span>' +
        (p.status === 'test' ? ' <span class="brand-opt-tag">test</span>' : p.status === 'archived' ? ' <span class="brand-opt-tag">archived</span>' : '') +
        (p.id === current ? ' <i class="fa-solid fa-check"></i>' : '') + '</button>';
    }).join('');
    menu.hidden = !brandMenuOpen;
    brand.classList.toggle('menu-open', brandMenuOpen);
  }

  function switchProject(id) {
    if (!id || id === A.getProject()) return;
    // Production: each project is its own subdomain (= its own browser origin),
    // so switching is a FULL redirect — no in-place swap can leak one project's
    // cache/session into another. Landing on a fresh origin starts clean.
    if (A.projectFromHost()) {
      location.href = 'https://' + id + '.designthinking.lk/';
      return;
    }
    // Localhost/dev: no subdomains — keep the in-place swap for the editor.
    A.setProject(id);
    teamDetailCache = {};
    state.data = A.readCache(); // instant if this project was loaded before
    state.loaded = false;
    state.q = ''; state.roleFilter = 'all'; state.skillFilter = null; state.teamFilter = null;
    adminProjects = null;
    userProjects = null;
    deletingUserId = null;
    inviteCard = null;
    renderChrome();
    route();
    refresh();
  }

  // Small dropdown anchored under the avatar button (not a full-screen modal).
  function openMenu(kind) {
    var pop = $('#menuPop');
    if (!pop) return;
    if (!pop.hidden && pop.getAttribute('data-kind') === kind) { closeMenu(); return; }
    var d = state.data || {};
    var items;
    // Horizontal strip: first item sits nearest the avatar (row-reverse in CSS).
    if (kind === 'user' && d.me) {
      items =
        '<a class="menu-item" href="#/profile/' + esc(d.me.id) + '" data-action="menu-nav" title="My profile"><i class="fa-regular fa-user"></i>My profile</a>' +
        '<button class="menu-item danger" data-action="sign-out" title="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i>Sign out</button>';
    } else {
      // Signed in but not registered — the "Complete registration" CTA already
      // lives in the topbar, so the menu only needs sign-out.
      items = '<button class="menu-item danger" data-action="sign-out" title="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i>Sign out</button>';
    }
    pop.innerHTML = items;
    pop.setAttribute('data-kind', kind);
    pop.hidden = false;
  }
  function closeMenu() {
    var pop = $('#menuPop');
    if (pop) { pop.hidden = true; pop.removeAttribute('data-kind'); }
  }

  // ------------------------------------------------------------- chat pane
  // Toggleable right rail listing everyone who has a workshop @designthinking.lk
  // account; clicking opens the 1:1 Google Chat DM (js/chat.js).

  function chatKey() { return 'ice.chat.' + A.getProject(); }

  function workEmailOf(u) {
    var w = u && u.workEmail;
    return (w && /@designthinking\.lk$/i.test(w)) ? w : '';
  }

  // ---- in-site Google Chat messaging (see js/chat.js) ----------------------
  // The Chat tab is a master-detail messenger: an inbox of 1:1 DMs
  // (chatUI.mode==='list') and one open conversation (chatUI.mode==='convo').
  // Google Chat has no browser push, so we poll — the open conversation every
  // CONVO_POLL ms and unread state every UNREAD_POLL ms. Read state is tracked
  // client-side by the last-seen message createTime per space.
  var chatUI = { mode: 'list', personId: null, space: null, msgs: null, err: '', draft: '' };
  var chatConn = { ready: false, myId: '', connecting: false, err: '' };
  var convoMeta = {};              // personId -> { space, lastTime, lastText, unread }
  var convoPollTimer = null, unreadPollTimer = null;
  var CONVO_POLL = 4000, UNREAD_POLL = 15000;

  // Master switch for direct 1:1 messaging (see ICE_CONFIG.CHAT_ENABLED).
  // false unwires every chat entry point — FAB, pane, "Message" buttons — while
  // leaving all the chat code (js/chat.js + the chat-* handlers) in place.
  function chatEnabled() { return !!C.CHAT_ENABLED; }

  function chatConfigured() { return !!(window.IceChat && window.IceChat.configured()); }

  // The people this user can DM: registered + carrying a workshop account.
  function chatRoster() {
    var users = (state.data && state.data.users) || [];
    var mine = me();
    return users.filter(function (u) {
      return hasAccess(u) && workEmailOf(u) && (!mine || u.id !== mine.id);
    });
  }

  // --- read tracking (per project, in localStorage) ---
  function seenKey() { return 'ice.chat.seen.' + A.getProject(); }
  function loadSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}'); } catch (e) { return {}; } }
  function saveSeen(m) { try { localStorage.setItem(seenKey(), JSON.stringify(m)); } catch (e) { /* private mode */ } }
  function markSeen(space, createTime) {
    if (!space || !createTime) return;
    var m = loadSeen();
    if ((m[space] || '') < createTime) { m[space] = createTime; saveSeen(m); }
    if (convoMeta[chatUI.personId] && convoMeta[chatUI.personId].space === space) convoMeta[chatUI.personId].unread = false;
  }

  // Acquire an OAuth token + the caller's Chat id. MUST be called from a user
  // gesture (the consent popup needs one). Idempotent once connected.
  // The workshop @designthinking.lk account is the one to message from — pin it
  // so a multi-account browser doesn't show the chooser on silent renewals.
  function chatAccountHint() { var u = me(); return u ? (u.workEmail || u.email || '') : ''; }

  async function chatConnect() {
    if (chatConn.ready) return true;
    chatConn.connecting = true; chatConn.err = '';
    try {
      window.IceChat.setAccount(chatAccountHint());
      await window.IceChat.connect();   // may show the Google popup
      await finishConnect();
      return true;
    } catch (err) {
      chatConn.err = err.message || 'Could not connect to Google Chat';
      throw err;
    } finally {
      chatConn.connecting = false;
    }
  }

  // Shared post-token setup for both the manual and silent connect paths.
  async function finishConnect() {
    var info = await window.IceChat.me();
    var want = chatAccountHint();
    // Guard against a multi-account browser handing back the wrong account —
    // Chat would then act as the wrong identity (DMs fail / go to the wrong place).
    if (want && info.email && info.email !== want) {
      window.IceChat.disconnect();
      chatConn.ready = false;
      chatConn.err = 'Connected as ' + info.email + '. Please choose your workshop account (' + want + ').';
      throw new Error(chatConn.err);
    }
    chatConn.myId = info.id;
    // A previously captured authoritative id (from a past send, keyed by
    // account) wins over the OpenID sub, so alignment is right before sending.
    try { var saved = localStorage.getItem('ice.chat.myid.' + info.email); if (saved) chatConn.myId = saved; } catch (e) { /* private mode */ }
    chatConn.ready = true;
    try { localStorage.setItem('ice.chat.granted', '1'); } catch (e) { /* private mode */ }
    startUnreadPoll();   // keep the fab badge live from here on
    sweepUnread();       // fire-and-forget first pass
  }

  // On load, silently re-establish the token (no popup) if the user has
  // connected before — so a refresh doesn't drop them back to the gate. The
  // GIS script loads async, so retry until it's ready.
  async function chatAutoConnect() {
    if (chatConn.ready || chatConn.autoTried) return;
    var granted = false;
    try { granted = localStorage.getItem('ice.chat.granted') === '1'; } catch (e) { /* private mode */ }
    if (!granted) return;                       // never auto-connect without a prior grant
    if (!chatConfigured()) {                     // GIS not loaded yet — retry shortly
      if (!chatConn.autoScheduled) {
        chatConn.autoScheduled = true;
        setTimeout(function () { chatConn.autoScheduled = false; chatAutoConnect(); }, 400);
      }
      return;
    }
    chatConn.autoTried = true;
    window.IceChat.setAccount(chatAccountHint());
    var ok = await window.IceChat.reconnect();   // silent; false if it needs UI
    if (!ok) return;                             // leave the gate; manual Connect still works
    try { await finishConnect(); }
    catch (err) { chatConn.autoTried = false; return; } // wrong account etc. — show gate
    if (commTab === 'chat') renderChatPane();     // reflect the now-connected state
  }

  function chatEmptyInbox() {
    return '<div class="chatpane-empty"><i class="fa-regular fa-comment-dots"></i>' +
      '<span>No workshop accounts yet.<br>People appear here once they register.</span></div>';
  }

  function chatConnectGate() {
    return '<div class="chatpane-empty chat-gate">' +
      '<i class="fa-regular fa-comments"></i>' +
      '<span>Message mentors and participants right here.</span>' +
      (chatConn.err ? '<span class="chat-gate-err">' + esc(chatConn.err) + '</span>' : '') +
      '<button class="btn btn-gradient btn-sm" data-action="chat-connect">' +
      '<span class="label"><i class="fa-brands fa-google"></i>Connect messaging</span><span class="spin"></span></button></div>';
  }

  // Inbox: everyone messageable, DMs-with-history first (newest reply on top),
  // then the rest alphabetically. Unread dot + last-message preview per row.
  function inboxHTML() {
    var roster = chatRoster();
    if (!roster.length) return chatEmptyInbox();
    roster.sort(function (a, b) {
      var ma = convoMeta[a.id], mb = convoMeta[b.id];
      var ta = (ma && ma.lastTime) || '', tb = (mb && mb.lastTime) || '';
      if (ta && tb) return ta < tb ? 1 : -1;
      if (ta) return -1;
      if (tb) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return roster.map(function (u) {
      var meta = convoMeta[u.id] || {};
      var sub = meta.lastText ? esc(clip(meta.lastText, 48)) : (u.affiliation ? esc(u.affiliation) : '');
      return '<button class="chat-row' + (meta.unread ? ' unread' : '') + '" data-action="chat-open-dm" data-person="' + esc(u.id) + '" title="Message ' + esc(u.name) + '">' +
        avatar(u, 'avatar-sm') +
        '<span class="chat-row-info"><span class="chat-row-name">' + esc(u.name) +
        (hasRoleU(u, 'mentor') ? ' <i class="fa-solid fa-star chat-row-star" title="Mentor"></i>' : '') + '</span>' +
        (sub ? '<span class="chat-row-sub">' + sub + '</span>' : '') + '</span>' +
        (meta.unread ? '<span class="chat-unread" aria-label="Unread"></span>' : '<i class="fa-regular fa-paper-plane chat-row-go"></i>') +
        '</button>';
    }).join('');
  }

  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // One open conversation: bubbles aligned by sender (mine right, theirs left).
  function convoHTML() {
    var u = userById(chatUI.personId);
    var head = '<div class="convo-head">' +
      '<button class="convo-back" data-action="chat-back" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>' +
      avatar(u, 'avatar-sm') +
      '<span class="convo-title">' + esc(u ? u.name : 'Conversation') + '</span></div>';
    var body;
    if (chatUI.err) {
      body = '<div class="chatpane-empty"><i class="fa-regular fa-face-frown"></i><span>' + esc(chatUI.err) + '</span></div>';
    } else if (chatUI.msgs === null) {
      body = '<div class="chatpane-empty convo-loading"><span class="spin-inline"></span></div>';
    } else if (!chatUI.msgs.length) {
      body = '<div class="chatpane-empty"><i class="fa-regular fa-comment"></i><span>No messages yet.<br>Say hello to ' + esc(u ? (u.name || '').split(' ')[0] : 'them') + '.</span></div>';
    } else {
      var msgs = chatUI.msgs;
      body = msgs.map(function (m, i) {
        var mine = isMine(m);
        var next = msgs[i + 1];
        // A run ends when the next message is from a different sender (or none).
        var endRun = !next || isMine(next) !== mine;
        var side = mine ? 'me' : 'them';
        var time = endRun ? '<div class="bubble-time">' + esc(timeAgo(m.createTime)) + '</div>' : '';
        var bubble = '<div class="msg-main"><div class="bubble">' + esc(m.text) + '</div>' + time + '</div>';
        if (mine) {
          return '<div class="msg me' + (endRun ? ' end' : '') + '">' + bubble + '</div>';
        }
        // Their side carries the avatar, but only on the last message of a run.
        var av = '<div class="msg-avatar">' + (endRun ? avatar(u, 'avatar-xs') : '') + '</div>';
        return '<div class="msg them' + (endRun ? ' end' : '') + '">' + av + bubble + '</div>';
      }).join('');
    }
    return head + '<div class="convo-scroll" id="convoScroll">' + body + '</div>';
  }

  // A message is mine when its sender matches my Chat id. myId comes from the
  // OpenID sub and is corrected from the authoritative sender on first send.
  function isMine(m) { return !!(chatConn.myId && m.senderId === chatConn.myId); }

  // Which tab of the comm pane is showing: 'chat' (1:1 DMs via Google Chat)
  // or 'broadcast' (announcements to everyone).
  var commTab = 'chat';

  function broadcastList() {
    var anns = ((state.data && state.data.announcements) || []).slice()
      .filter(function (a) { return a.isPublished; })
      .sort(function (a, b) {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    if (!anns.length) {
      return '<div class="chatpane-empty"><i class="fa-solid fa-bullhorn"></i>' +
        '<span>No broadcasts yet.<br>Messages to everyone appear here.</span></div>';
    }
    return anns.map(function (a) {
      var author = userById(a.authorId);
      return '<div class="bcast">' +
        '<div class="bcast-head"><span>' + (author ? esc(author.name) : 'Organizers') + '</span>' +
        '<span class="bcast-when">' + esc(timeAgo(a.createdAt)) + '</span></div>' +
        '<div class="bcast-title">' + (a.isPinned ? '<i class="fa-solid fa-thumbtack"></i> ' : '') + esc(a.title) + '</div>' +
        (a.content !== a.title ? '<p class="bcast-body">' + esc(a.content) + '</p>' : '') +
        '</div>';
    }).join('');
  }

  function renderChatPane() {
    var body = $('#chatpaneBody');
    if (!body) return;
    // Scoped to the chat pane's own tab strip — the admin tab bar reuses the
    // .comm-tab class, and a bare '.comm-tab' sweep here kept stripping the
    // admin bar's active highlight on every chrome re-render.
    $all('.comm-tabs .comm-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === commTab);
    });
    var foot = $('#commFoot');
    // preserve a broadcast draft across re-renders (refresh() redraws chrome)
    var draftEl = $('#bcastInput');
    var draft = draftEl ? draftEl.value : '';
    // preserve a half-typed chat message too
    var msgEl = $('#chatMsgInput');
    if (msgEl) chatUI.draft = msgEl.value;
    if (commTab === 'chat') {
      renderChatTab(body, foot);
    } else {
      body.innerHTML = broadcastList();
      if (foot) {
        foot.innerHTML = canAnnounce()
          ? '<div class="bcast-compose"><textarea class="input" id="bcastInput" rows="2" placeholder="Broadcast to everyone…"></textarea>' +
            '<button class="btn btn-gradient btn-sm" data-action="bcast-send" title="Send to everyone"><span class="label"><i class="fa-regular fa-paper-plane"></i></span><span class="spin"></span></button></div>'
          : '<div class="bcast-note">Broadcasts come from mentors &amp; organizers.</div>';
        var bi = $('#bcastInput');
        if (bi && draft) bi.value = draft;
      }
    }
  }

  // Renders the Chat tab: connect gate → inbox → conversation, plus the right
  // foot (nothing for the inbox, a composer for a conversation).
  function renderChatTab(body, foot) {
    if (!chatConfigured()) {
      body.innerHTML = '<div class="chatpane-empty"><i class="fa-regular fa-comment-dots"></i>' +
        '<span>Messaging isn’t set up yet.<br>Contact the organizers.</span></div>';
      if (foot) foot.innerHTML = '';
      return;
    }
    if (!chatConn.ready) {
      body.innerHTML = chatConnectGate();
      if (foot) foot.innerHTML = '';
      return;
    }
    if (chatUI.mode === 'convo') {
      body.innerHTML = convoHTML();
      body.classList.add('is-convo');
      if (foot) {
        foot.innerHTML = '<div class="chat-compose">' +
          '<textarea class="input" id="chatMsgInput" rows="1" placeholder="Message…"></textarea>' +
          '<button class="btn btn-gradient btn-sm" data-action="chat-send" title="Send"><span class="label"><i class="fa-regular fa-paper-plane"></i></span><span class="spin"></span></button></div>';
        var mi = $('#chatMsgInput');
        if (mi) {
          mi.value = chatUI.draft || ''; autoGrow(mi);
          var pane = $('#chatpane');
          if (pane && !pane.hidden) mi.focus(); // don't steal focus into a hidden pane
        }
      }
      scrollConvoToBottom();
    } else {
      body.innerHTML = inboxHTML();
      body.classList.remove('is-convo');
      if (foot) foot.innerHTML = '';
    }
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 110) + 'px';
  }

  function scrollConvoToBottom() {
    var s = $('#convoScroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  // --- conversation open/close + polling ---
  async function openConvo(personId) {
    var u = userById(personId);
    var email = u && workEmailOf(u);
    if (!email) { toast('This person has no workshop account yet.', true); return; }
    chatUI = { mode: 'convo', personId: personId, space: null, msgs: null, err: '', draft: '' };
    renderChatPane();
    try {
      await chatConnect();
      var space = await window.IceChat.ensureDm(email);
      chatUI.space = space;
      var msgs = await window.IceChat.listMessages(space, 50);
      chatUI.msgs = msgs;
      if (msgs.length) markSeen(space, msgs[msgs.length - 1].createTime);
      convoMeta[personId] = convoMeta[personId] || {};
      convoMeta[personId].space = space;
      convoMeta[personId].unread = false;
      renderChatPane();
      updateChatBadge();
      startConvoPoll();
    } catch (err) {
      chatUI.err = err.message || 'Could not open this conversation';
      renderChatPane();
    }
  }

  function closeConvo() {
    stopConvoPoll();
    chatUI = { mode: 'list', personId: null, space: null, msgs: null, err: '', draft: '' };
    renderChatPane();
    sweepUnread();
  }

  function startConvoPoll() {
    stopConvoPoll();
    convoPollTimer = setInterval(refreshConvoMessages, CONVO_POLL);
  }
  function stopConvoPoll() {
    if (convoPollTimer) { clearInterval(convoPollTimer); convoPollTimer = null; }
  }

  async function refreshConvoMessages() {
    if (chatUI.mode !== 'convo' || !chatUI.space) return;
    var pane = $('#chatpane');
    if (!pane || pane.hidden) return; // don't poll a closed pane
    try {
      var msgs = await window.IceChat.listMessages(chatUI.space, 50);
      var before = chatUI.msgs ? chatUI.msgs.length : 0;
      var lastId = chatUI.msgs && chatUI.msgs.length ? chatUI.msgs[chatUI.msgs.length - 1].id : '';
      chatUI.msgs = msgs;
      var newLast = msgs.length ? msgs[msgs.length - 1] : null;
      if (newLast && newLast.id !== lastId) {
        // Only redraw the thread (keep the composer + its draft untouched).
        var body = $('#chatpaneBody');
        if (body) { body.innerHTML = convoHTML(); scrollConvoToBottom(); }
        markSeen(chatUI.space, newLast.createTime);
      } else if (!before && msgs.length) {
        var b2 = $('#chatpaneBody'); if (b2) { b2.innerHTML = convoHTML(); scrollConvoToBottom(); }
      }
    } catch (err) { /* transient; next tick retries */ }
  }

  async function sendChatMessage(btn) {
    var input = $('#chatMsgInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || !chatUI.space) return;
    busy(btn, true);
    try {
      var msg = await window.IceChat.sendMessage(chatUI.space, text);
      // The send response's sender IS me — authoritative for bubble alignment,
      // in case the OpenID `sub` and Chat user id ever differ. Persist it so
      // future sessions align history correctly from the first render.
      if (msg.senderId) {
        chatConn.myId = msg.senderId;
        var acct = (window.IceChat.account && window.IceChat.account()) || '';
        try { localStorage.setItem('ice.chat.myid.' + acct, msg.senderId); } catch (e) { /* private mode */ }
      }
      input.value = ''; chatUI.draft = ''; autoGrow(input);
      chatUI.msgs = (chatUI.msgs || []).concat([msg]);
      markSeen(chatUI.space, msg.createTime);
      if (convoMeta[chatUI.personId]) {
        convoMeta[chatUI.personId].lastTime = msg.createTime;
        convoMeta[chatUI.personId].lastText = msg.text;
      }
      var body = $('#chatpaneBody');
      if (body) { body.innerHTML = convoHTML(); scrollConvoToBottom(); }
      input.focus();
    } catch (err) {
      // Surface which account is sending — a "permission denied" here usually
      // means Google Chat isn't enabled for that workshop account.
      var acct = (window.IceChat.account && window.IceChat.account()) || '';
      toast((err.message || 'Message not sent') + (acct ? ' (as ' + acct + ')' : ''), true);
    }
    busy(btn, false);
  }

  // --- unread sweep + fab badge ---
  // Discovers each roster person's DM space (findDirectMessage) and its latest
  // message, marking a conversation unread when the newest message is newer
  // than what we've seen and wasn't sent by us.
  async function sweepUnread() {
    if (!chatConn.ready || !chatConfigured()) return;
    var roster = chatRoster();
    var seen = loadSeen();
    for (var i = 0; i < roster.length; i++) {
      var u = roster[i];
      var email = workEmailOf(u);
      try {
        var space = (convoMeta[u.id] && convoMeta[u.id].space) || await window.IceChat.findDm(email);
        if (!space) continue;
        var last = await window.IceChat.latestMessage(space);
        var meta = convoMeta[u.id] = convoMeta[u.id] || {};
        meta.space = space;
        if (last) {
          meta.lastTime = last.createTime;
          meta.lastText = last.text;
          meta.unread = (seen[space] || '') < last.createTime && last.senderId !== chatConn.myId;
        }
      } catch (err) { /* skip this person this round */ }
    }
    updateChatBadge();
    // If the inbox is on screen, reflect new previews/dots.
    var pane = $('#chatpane');
    if (pane && !pane.hidden && commTab === 'chat' && chatUI.mode === 'list') {
      var body = $('#chatpaneBody'); if (body) body.innerHTML = inboxHTML();
    }
  }

  function unreadCount() {
    var n = 0;
    Object.keys(convoMeta).forEach(function (k) { if (convoMeta[k] && convoMeta[k].unread) n++; });
    return n;
  }

  function updateChatBadge() {
    var badge = $('#chatBadge');
    if (!badge) return;
    var n = unreadCount();
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = n === 0;
  }

  function startUnreadPoll() {
    stopUnreadPoll();
    if (!chatConn.ready) return;
    unreadPollTimer = setInterval(function () {
      if (chatUI.mode !== 'convo') sweepUnread();
    }, UNREAD_POLL);
  }
  function stopUnreadPoll() {
    if (unreadPollTimer) { clearInterval(unreadPollTimer); unreadPollTimer = null; }
  }

  function setChatPane(open) {
    var pane = $('#chatpane');
    if (!pane) return;
    pane.hidden = !open;
    document.body.classList.toggle('chat-open', open);
    localStorage.setItem(chatKey(), open ? 'open' : 'closed');
    if (open) {
      renderChatPane();
      // Resume polling if we're reopening onto an already-open conversation.
      if (commTab === 'chat' && chatUI.mode === 'convo' && chatUI.space) {
        startConvoPoll();
        refreshConvoMessages();
      }
    } else {
      stopConvoPoll();
    }
  }

  // ---------------------------------------------------------------- views

  function skillChip(s, on, actionable, noMine) {
    return '<span class="chip' + (on ? ' on' : '') + (actionable === false ? ' static' : '') +
      ((!noMine && isMySkill(s)) ? ' is-mine' : '') + '"' +
      (actionable === false ? '' : ' data-action="filter-skill" data-skill="' + esc(s) + '"') + '>' + esc(s) + '</span>';
  }

  function personCard(u) {
    var isMentor = hasRoleU(u, 'mentor');
    var skills = (u.skills || []).slice(0, 3).map(function (s) { return skillChip(s, false, false); }).join('');
    var more = (u.skills || []).length > 3 ? '<span class="more">+' + ((u.skills || []).length - 3) + ' more</span>' : '';
    return '<a class="card person' + (isMentor ? ' mentor' : '') + '" href="#/profile/' + esc(u.id) + '">' +
      '<div class="person-top">' + avatar(u) +
      '<div><div class="person-name">' + esc(u.name) +
      (isMentor ? '<span class="role-tag mentor"><i class="fa-solid fa-star"></i>Mentor</span>' : '') +
      (hasRoleU(u, 'catalyst') ? '<span class="role-tag catalyst"><i class="fa-solid fa-bolt"></i>Catalyst</span>' : '') +
      (hasRoleU(u, 'admin') ? '<span class="role-tag admin"><i class="fa-solid fa-shield-halved"></i>Organizer</span>' : '') +
      '</div>' +
      (u.affiliation ? '<div class="person-affil">' + esc(u.affiliation) + '</div>' : '') +
      '</div></div>' +
      (u.bio ? '<div class="person-bio">' + esc(u.bio) + '</div>' : '') +
      '<div class="skills">' + skills + more + '</div></a>';
  }

  // People view — every participant & mentor rendered as an octagon tile,
  // arranged to spell the ICE wordmark. Greyscale + duotone tint by role
  // (mentors purple, participants cyan). Hovering a face dims the rest and
  // shows a large preview in the hollow of the C. Clicking opens the profile.

  // 42 slots total = 6 teams × 7 — trimmed from 48 so a full workshop fills the
  // wordmark exactly: I loses its 4 serif-end corners (5-wide → 3-wide top &
  // bottom), C loses its 2 left-side corners. I=11, C=13, E=18.
  var WORD_LETTERS = [
    ['01110', '00100', '00100', '00100', '00100', '00100', '01110'], // I
    ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], // C
    ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], // E
  ];
  var WORD_GAP = 1.4; // empty columns between letters
  // The I hugs the left edge and paints over the nav rail. Nudge just the I
  // right by one grid column — the bounding box is measured from base positions
  // (below), so C, E and the centring stay put; the vacated column becomes a
  // left margin the nav sits in.
  var I_SHIFT = 1; // columns the I glyph slides right (0 = flush left)

  // Build the ordered list of cells (grid col/row) plus the C-hollow centroid.
  function wordCells() {
    var cells = [], origins = [], cursor = 0;
    WORD_LETTERS.forEach(function (L, li) {
      origins.push(cursor);
      var cols = L[0].length;
      for (var r = 0; r < L.length; r++) {
        for (var c = 0; c < cols; c++) {
          if (L[r][c] === '1') cells.push({ r: r, c: cursor + c, letter: li });
        }
      }
      cursor += cols + WORD_GAP;
    });
    var Cl = WORD_LETTERS[1], Co = origins[1], sc = 0, sr = 0, n = 0;
    for (var rr = 0; rr < Cl.length; rr++) {
      for (var cc = 0; cc < Cl[0].length; cc++) {
        if (Cl[rr][cc] === '0') { sc += Co + cc; sr += rr; n++; }
      }
    }
    // Four RESERVED slots for catalysts (special guests). Three fill currently-
    // empty cells that sit INSIDE a letter's existing column span, so the ICE
    // bounding box — and therefore the whole formation's size and centring — is
    // unchanged. The fourth floats just off the formation's bottom-right; it's
    // positioned in buildWordmark relative to the measured box (and excluded
    // from that measurement) so it, too, never nudges the letters.
    //   1. C top-left corner   (row 0, C col 0)
    //   2. C bottom-left corner (row 6, C col 0)
    //   3. E middle-branch end  (row 3, E col 4)
    //   4. floating bottom-right accent
    var reserved = [
      { r: 0, c: origins[1] + 0, letter: 1 },
      { r: 6, c: origins[1] + 0, letter: 1 },
      { r: 3, c: origins[2] + 4, letter: 2 },
      { floating: true },
    ];
    return { cells: cells, hollow: { col: sc / n, row: sr / n }, reserved: reserved };
  }

  // Team list for the filter chips — one per team, sorted by name; before any
  // teams exist, a Team A–F scaffold keeps the filter visible and interactive.
  function homeTeams() {
    var teams = ((state.data && state.data.teams) || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    if (!teams.length) {
      teams = ['A', 'B', 'C', 'D', 'E', 'F'].map(function (l) {
        return { id: 'demo-team-' + l, name: 'Team ' + l, members: [], demo: true };
      });
    }
    return teams;
  }

  // My team (the real team whose members include me) and its slot in the
  // homeTeams() order — which is also the slot its project card sits at. -1
  // when I'm not on a team yet (or signed out).
  function myTeam() {
    var m = me(); if (!m) return null;
    var found = null;
    homeTeams().forEach(function (t) {
      if (!t.demo && (t.members || []).indexOf(m.id) !== -1) found = t;
    });
    return found;
  }
  function myTeamSlot() {
    var t = myTeam(); if (!t) return -1;
    var teams = homeTeams();
    for (var i = 0; i < teams.length; i++) if (teams[i].id === t.id) return i;
    return -1;
  }

  // Team filter chips — rendered into the app bar (renderChrome), People view only.
  function teamChipsHtml() {
    if (!state.data) return '';
    var teams = homeTeams();
    if (state.teamFilter && !teams.some(function (t) { return t.id === state.teamFilter; })) {
      state.teamFilter = null; // team went away
    }
    // chain stack: later chips tuck under earlier ones (descending z-index),
    // only their tail letter visible. Chips after the first hide their "Team"
    // prefix via an invisible span — size and letter placement stay identical.
    var mine = myTeam();
    return '<div class="hive-teams" id="hiveTeams">' +
      teams.map(function (t, i) {
        var name = String(t.name || '');
        var cut = name.lastIndexOf(' ') + 1;
        var label = (i === 0 || !cut)
          ? esc(name)
          : '<span class="tc-ghost">' + esc(name.slice(0, cut)) + '</span>' + esc(name.slice(cut));
        return '<button class="team-chip' + (t.id === state.teamFilter ? ' on' : '') + (t.demo ? ' demo' : '') +
          (mine && t.id === mine.id ? ' is-mine' : '') + '" type="button" ' +
          'style="z-index:' + (teams.length - i) + '" ' +
          'data-action="filter-team" data-team="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' + label + '</button>';
      }).join('') + '</div>';
  }

  // mentors/participants/catalysts counts — shown beside the team chain in the app bar
  function topbarLegendHtml() {
    var all = (state.data && state.data.users) || [];
    var mentors = all.filter(function (u) { return hasRoleU(u, 'mentor'); }).length;
    var participants = all.filter(function (u) { return hasRoleU(u, 'participant'); }).length;
    var catalysts = all.filter(isCatalyst).length;
    return '<div class="topbar-legend">' +
      '<span><span class="dot mentor"></span>' + mentors + ' mentor' + (mentors === 1 ? '' : 's') + '</span>' +
      '<span><span class="dot participant"></span>' + participants + ' participant' + (participants === 1 ? '' : 's') + '</span>' +
      (catalysts ? '<span><span class="dot catalyst"></span>' + catalysts + ' catalyst' + (catalysts === 1 ? '' : 's') + '</span>' : '') +
      '</div>';
  }

  // Landing (#/): chrome only, empty middle apart from the feature video from
  // the last workshop — fades in after a beat, edges masked into the page.
  // Lower-right: last workshop's name + numbers stacked just above the
  // About fab — which is the door to #/about.
  function viewLanding() {
    return '<div class="landing">' +
      '<div class="feature-video">' +
      '<video class="feature-video-el" autoplay muted loop playsinline preload="auto" ' +
      'title="ICE workshop highlights" tabindex="-1">' +
      '<source src="assets/video/ice2025-landing.mp4?v=2" type="video/mp4"></video>' +
      '</div>' +
      // loading veil: drifts a subtle gradient over the video slot until the
      // playback handshake reveals the footage (initLandingVideo crossfades it)
      '<div class="landing-loader"></div>' +
      '<div class="landing-intro">' +
      '<a class="li-year" href="https://www.ice2025.com/" target="_blank" rel="noopener">ICE2025</a>' +
      '<div class="li-stats">' +
      '<span class="stat"><b>30</b><span>participants</span></span>' +
      '<span class="stat"><b>6</b><span>universities</span></span>' +
      '<span class="stat"><b>14</b><span>facilitators</span></span>' +
      '<span class="stat"><b>40</b><span>hours in 3 days</span></span>' +
      '</div>' +
      '</div></div>';
  }

  // Fade the feature video in once it actually starts playing, so the loading
  // veil crossfades onto real footage rather than a black frame. Falls back to
  // a plain timer if the media events never fire (e.g. autoplay blocked).
  function initLandingVideo(fv) {
    if (fv.__wired) return;
    fv.__wired = true;
    var vid = fv.querySelector('video');
    var shown = false;
    function show(delay) {
      if (shown) return;
      shown = true;
      setTimeout(function () {
        fv.classList.add('show');
        // crossfade: the veil fades out on the same clock the video fades in
        var veil = fv.parentElement && fv.parentElement.querySelector('.landing-loader');
        if (veil) veil.classList.add('done');
      }, delay);
    }
    if (vid) {
      vid.addEventListener('playing', function () { show(0); });
      // some browsers fire 'canplay'/'loadeddata' without 'playing' when muted
      vid.addEventListener('loadeddata', function () { if (vid.currentTime > 0 || !vid.paused) show(0); });
      var p = vid.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked — safety net reveals it */ });
    }
    setTimeout(function () { show(0); }, 5000); // safety net — cap the wait at 5s
  }

  function viewHome() {
    var d = state.data;
    if (!d) return skeletons();
    var activeTeam = null;
    homeTeams().forEach(function (x) { if (x.id === state.teamFilter) activeTeam = x; });
    if (state.teamFilter && !activeTeam) state.teamFilter = null;
    // legend lives in the app bar beside the team chain; caption inside the
    // preview octagon (buildWordmark)
    return '<div class="hive">' +
      '<div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div class="hive-stage" id="hiveStage"><div class="word" id="word"></div></div>' +
      '</div>';
  }

  function hiveCaptionText(users, team) {
    if (team) return 'Showing ' + esc(team.name) + ' — tap the chip again to clear';
    return users.length ? '' : 'Waiting for people to join — slots fill as they register';
  }

  // The whole ICE wordmark always renders. Cells with no assigned user yet are
  // placeholder octagons; joining users are assigned round-robin across I/C/E so
  // early joiners scatter across the letters instead of clustering in one.
  function slotOrder(cells) {
    var groups = [[], [], []];
    cells.forEach(function (cell, idx) { groups[cell.letter].push(idx); });
    var order = [], maxLen = Math.max(groups[0].length, groups[1].length, groups[2].length);
    for (var rk = 0; rk < maxLen; rk++) {
      for (var li = 0; li < 3; li++) if (groups[li][rk] !== undefined) order.push(groups[li][rk]);
    }
    return order;
  }

  // The large preview hexagon (in the C's hollow) features Prof. Suranga
  // Nanayakkara by default — his portrait sits there whenever no member tile is
  // being hovered. Hovering a small tile swaps him out for that person; the
  // large tile itself is not a link (to open a profile, click the small tile).
  // name in the name slot, "Prof" in the role slot (where Mentor/Participant
  // shows for others) so the label lines up with everyone else's placement.
  var HIVE_FEATURE = { image: 'assets/about/suranga-hive.jpg', name: 'Suranga Nanayakkara', role: 'Prof', kind: 'cat' };

  // Fill the large preview hexagon's photo pin. opts: {image,name,role,kind}.
  function fillHivePreview(word, opts) {
    var img = $('#hivePvImg'), nm = $('#hivePvNm'), role = $('#hivePvRole');
    if (img) img.src = opts.image || '';
    if (nm) nm.textContent = opts.name || '';
    if (role) role.textContent = opts.role || '';
    var p = word.__preview;
    if (p) { p.classList.remove('m', 'p', 'cat', 'fadeout'); p.classList.add(opts.kind || 'cat', 'on'); }
  }

  // Populate the wordmark tiles from live users, then size to fit (no scroll).
  function buildWordmark() {
    var word = $('#word');
    if (!word) return;
    // Community members (participant/mentor) fill the 42 letter cells; catalysts
    // (special guests) fill the 4 reserved slots. Role-less rows (access removed)
    // stay off the hive entirely.
    var allUsers = (state.data && state.data.users) || [];
    var users = allUsers.filter(isCommunityMember);
    var catalysts = allUsers.filter(isCatalyst);
    var onlineIds = (state.data && state.data.online) || [];
    var built = wordCells();
    var cells = built.cells;
    var w = 74, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    cells.forEach(function (cell) {
      var bx = cell.c * w; // base column position (drives the bounding box)
      // render the I one column to the right; C/E stay at their base position
      cell.x = bx + (cell.letter === 0 ? I_SHIFT * w : 0);
      cell.y = cell.r * w;
      // measure from base positions so the box, C/E and centring are unchanged —
      // the I just slides right within the reserved left margin. Reserved
      // catalyst slots are deliberately NOT measured, so they never move ICE.
      minX = Math.min(minX, bx); maxX = Math.max(maxX, bx + w);
      minY = Math.min(minY, cell.y); maxY = Math.max(maxY, cell.y + w);
    });
    // Natural (unscaled) dimensions; fitWordmark scales from these and sets the
    // layout box to the scaled size so flexbox can centre it at any width.
    word.__w = maxX - minX;
    word.__h = maxY - minY;
    word.innerHTML = '';

    // A single hive tile — a filled member octagon (kind 'p'|'m'|'cat') wired to
    // the preview, or an empty placeholder for an open slot.
    function makeTile(u, kind) {
      var el;
      if (u) {
        var isOn = onlineIds.indexOf(u.id) !== -1;
        el = document.createElement('a');
        el.className = 'oct ' + kind;
        el.href = '#/profile/' + u.id;
        el.title = u.name + (isOn ? ' — online' : '');
        el.setAttribute('data-uid', u.id);
        el.innerHTML = '<div class="oct-in">' +
          (u.image ? '<img src="' + esc(u.image) + '" alt="" loading="lazy">' : '<span class="oct-blank">' + esc(initials(u.name)) + '</span>') +
          '</div>' +
          (isOn ? '<span class="oct-online" title="Online"></span>' : '');
        // Hover shows the person in the large hexagon; the click just follows the
        // tile's own href to their profile (no pin/hold).
        el.addEventListener('mouseenter', function () { showHivePreview(u, kind, el); });
        el.addEventListener('mouseleave', hideHivePreview);
      } else {
        el = document.createElement('div');
        el.className = 'oct empty' + (kind === 'cat' ? ' cat' : '');
        el.innerHTML = '<div class="oct-in"><span class="oct-slot"><i class="fa-solid fa-' + (kind === 'cat' ? 'bolt' : 'user') + '"></i></span></div>';
      }
      el.style.width = w + 'px'; el.style.height = w + 'px';
      return el;
    }

    // map each assigned community user onto a spread-out cell
    var order = slotOrder(cells), cellUser = {};
    for (var k = 0; k < users.length && k < order.length; k++) cellUser[order[k]] = users[k];

    cells.forEach(function (cell, i) {
      var u = cellUser[i];
      var el = makeTile(u, u ? (hasRoleU(u, 'mentor') ? 'm' : 'p') : 'p');
      el.style.left = (cell.x - minX) + 'px';
      el.style.top = (cell.y - minY) + 'px';
      // intro fade: whole letter-group appears at once, I → C → E, slight stagger
      el.style.animationDelay = (cell.letter * 0.35) + 's';
      word.appendChild(el);
    });

    // Reserved catalyst slots — always shown (empty until a catalyst joins) so
    // the four opened slots are visible. The first three are grid-anchored to
    // currently-empty cells inside a letter's span; the fourth floats just off
    // the formation's bottom-right. All four are positioned from the measured
    // box but excluded from it, so none of them shift the ICE letters. Extra
    // catalysts beyond four have no slot (only four exist).
    // Preview hexagon geometry — computed here so the 4th (floating) catalyst
    // slot can be tucked beside it. Parked in the C's hollow, nudged right so its
    // right edge lines up with the C letter's right-most edge (letter index 1).
    var pw = w * 2.9, ph = pw;
    var cRight = -1e9;
    cells.forEach(function (cell) { if (cell.letter === 1) cRight = Math.max(cRight, cell.c * w + w); });
    var pvCenterX = (cRight > -1e9) ? (cRight - pw / 2) : ((built.hollow.col + 0.5) * w);
    var pvCenterY = (built.hollow.row + 0.5) * w;

    (built.reserved || []).forEach(function (slot, ri) {
      var el = makeTile(catalysts[ri], 'cat');
      el.classList.add('oct-reserved');
      var left, top;
      if (slot.floating) {
        el.classList.add('oct-float');
        // Sits in the C–E gap just to the lower-right of the large preview
        // hexagon, so it reads as beside it without covering the portrait.
        // Tunable via these two factors; the extra + w drops it one tile-height
        // lower so it clears the hexagon completely.
        left = (pvCenterX + pw * 0.64) - minX - w / 2;
        top = (pvCenterY + pw * 0.22) - minY - w / 2 + w;
      } else {
        left = (slot.c * w) - minX;
        top = (slot.r * w) - minY;
      }
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.animationDelay = '1.1s';     // fade in just after the E group
      word.appendChild(el);
    });

    var preview = document.createElement('div');
    preview.className = 'oct-preview';
    preview.style.width = pw + 'px'; preview.style.height = ph + 'px';
    preview.style.left = (pvCenterX - minX - pw / 2) + 'px';
    preview.style.top = (pvCenterY - minY - ph / 2) + 'px';
    // The photo pin fills the hexagon. There's no "View profile" link and the
    // tile isn't a link — clicking a small tile opens that person's profile.
    preview.innerHTML = '<span class="hive-caption"></span>' +
      '<div class="oct-pin"><img id="hivePvImg" alt="">' +
      '<span class="oct-pvname"><span id="hivePvNm"></span><span class="oct-pvrole" id="hivePvRole"></span></span></div>';
    // the C-hollow preview reveals just after the last letter (E)
    preview.style.animationDelay = '0.95s';
    word.appendChild(preview);
    word.__preview = preview;
    // Default: feature Suranga until a member tile is hovered.
    fillHivePreview(word, HIVE_FEATURE);
    // hollow centre in natural coords — fitWordmark re-sizes the preview from it.
    // Keep it aligned with the right-nudged position so fitWordmark doesn't undo it.
    word.__hollowX = pvCenterX - minX;
    word.__hollowY = pvCenterY - minY;

    // Fresh render fits the CURRENT width; the size only locks once the user
    // narrows the window from there (see fitWordmark).
    hiveFit.scale = 0; hiveOverflow = false;
    fitWordmark();
    applyTeamFilter(); // re-assert an active team highlight after any rebuild
  }

  // Spotlight the octagons of the currently-filtered team (state.teamFilter),
  // dimming everyone else. No-op when no team is selected. Called on rebuilds
  // and on chip toggles so no full re-render is needed.
  function applyTeamFilter() {
    var word = $('#word');
    if (!word) return;
    var team = null;
    ((state.data && state.data.teams) || []).forEach(function (x) { if (x.id === state.teamFilter) team = x; });
    var members = {};
    if (team) (team.members || []).forEach(function (mid) { members[mid] = 1; });
    word.classList.toggle('teamfocus', !!team);
    $all('.oct[data-uid]', word).forEach(function (el) {
      el.classList.toggle('team-member', !!members[el.getAttribute('data-uid')]);
    });
  }

  // Hover a small tile → show that person in the large hexagon.
  function showHivePreview(u, kind, el) {
    var word = $('#word'); if (!word) return;
    word.classList.add('focus');
    word.__pvUid = u.id;
    if (word.__active) word.__active.classList.remove('active');
    el.classList.add('active'); word.__active = el;
    fillHivePreview(word, {
      image: u.image, name: u.name, kind: kind,
      role: kind === 'cat' ? 'Catalyst' : kind === 'm' ? 'Mentor' : 'Participant',
    });
  }
  // Mouse leaves → revert the large hexagon to its featured default (Suranga).
  function hideHivePreview() {
    var word = $('#word'); if (!word) return;
    word.classList.remove('focus');
    word.__pvUid = null;
    if (word.__active) { word.__active.classList.remove('active'); word.__active = null; }
    fillHivePreview(word, HIVE_FEATURE);
  }

  // Wordmark sizing state: `scale`/`w` lock the ICE size so narrowing the window
  // scrolls instead of shrinking; `hiveOverflow`/`lastHiveToast` gate the nudge.
  var hiveFit = { scale: 0, w: 0 };
  var hiveOverflow = false;
  var lastHiveToast = 0;
  // Fit the wordmark to the stage; keeps a stable size + scrolls when narrowed.
  function fitWordmark() {
    var stage = $('#hiveStage'), word = $('#word');
    if (!stage || !word || !word.__w) return;
    var ww = word.__w, wh = word.__h;
    var pad = 24; // tight padding — the fixed sidebar shouldn't shrink the ICE
    var widthFit = (stage.clientWidth - pad) / ww;
    var heightFit = (stage.clientHeight - pad) / wh;
    var s;
    // Keep the ICE a STABLE size when the window only gets narrower: reuse the
    // last fitted scale (never shrink/reflow the letters) and let the stage
    // scroll horizontally instead. Re-fit (grow) when the window widens; still
    // clamp to the height so the wordmark never overflows vertically.
    if (hiveFit.scale && stage.clientWidth < hiveFit.w) {
      s = Math.min(hiveFit.scale, heightFit, 1.5);
    } else {
      s = Math.min(widthFit, heightFit, 1.5);
      hiveFit.scale = s; hiveFit.w = stage.clientWidth;
    }
    if (!(s > 0) || !isFinite(s)) return;
    // Scale from the top-left and shrink the layout box to the scaled size, so the
    // flexbox-centred stage keeps equal margins whether the sidebar is open or not.
    word.style.transformOrigin = 'top left';
    word.style.transform = 'scale(' + s + ')';
    word.style.width = (ww * s) + 'px';
    word.style.height = (wh * s) + 'px';
    // Horizontal overflow → the stage shows a scrollbar. Nudge the user once each
    // time it flips from fitting to overflowing (throttled against wiggle).
    var overflowing = (ww * s) > (stage.clientWidth - pad + 2);
    if (overflowing && !hiveOverflow && Date.now() - lastHiveToast > 4000) {
      toast('Better experience in full screen');
      lastHiveToast = Date.now();
    }
    hiveOverflow = overflowing;
    // preview octagon renders at exactly 280px — the same size as the nav's
    // half octagon (.side-oct) — by compensating for the wordmark scale
    if (word.__preview && word.__hollowX !== undefined) {
      var pv = 280 / s;
      word.__preview.style.width = pv + 'px';
      word.__preview.style.height = pv + 'px';
      word.__preview.style.left = (word.__hollowX - pv / 2) + 'px';
      word.__preview.style.top = (word.__hollowY - pv / 2) + 'px';
    }
  }

  function skeletons() {
    return '<div class="grid grid-people" style="margin-top:40px">' +
      new Array(8).join('<div class="skeleton"></div>') + '</div>';
  }

  // Map a profile link to a brand icon + a short label (used for the header's
  // icon-only link buttons). Unknown hosts fall back to a globe + bare domain.
  function profileLinkMeta(url) {
    var u = String(url || '');
    if (/github\.com/i.test(u)) return { icon: 'fa-brands fa-github', label: 'GitHub' };
    if (/linkedin\.com/i.test(u)) return { icon: 'fa-brands fa-linkedin-in', label: 'LinkedIn' };
    if (/(?:twitter\.com|x\.com)/i.test(u)) return { icon: 'fa-brands fa-x-twitter', label: 'X' };
    if (/instagram\.com/i.test(u)) return { icon: 'fa-brands fa-instagram', label: 'Instagram' };
    if (/facebook\.com/i.test(u)) return { icon: 'fa-brands fa-facebook-f', label: 'Facebook' };
    if (/youtube\.com|youtu\.be/i.test(u)) return { icon: 'fa-brands fa-youtube', label: 'YouTube' };
    return { icon: 'fa-solid fa-globe', label: u.replace(/^https?:\/\//, '').replace(/\/$/, '') };
  }

  function viewProfile(id) {
    var u = userById(id);
    if (!u) return state.loaded
      ? '<div class="empty"><i class="fa-regular fa-user"></i>Profile not found.</div>'
      : skeletons();
    var isMe = me() && me().id === id;
    // Links show as brand-icon buttons in the header (top-right), not a text list.
    var linkIcons = (u.links || []).map(function (l) {
      var m = profileLinkMeta(l);
      return '<a class="pv-link" href="' + esc(l) + '" target="_blank" rel="noopener" title="' +
        esc(m.label) + '" aria-label="' + esc(m.label) + '"><i class="' + m.icon + '"></i></a>';
    }).join('');
    var pvLinks = linkIcons ? '<div class="pv-links">' + linkIcons + '</div>' : '';
    var myTeams = (state.data.teams || []).filter(function (t) { return (t.members || []).indexOf(u.id) !== -1; });

    // Action buttons (Edit / Message / Sign-in, plus Share) now live in the
    // right-hand actions box alongside the link icons.
    var actionBtns =
      (isMe ? '<a class="btn btn-outline btn-sm" href="#/me"><i class="fa-solid fa-pen"></i>Edit profile</a>'
            : (!chatEnabled() ? ''            // messaging temporarily disabled — no Message CTA
            : (signedIn() && me()
                ? (workEmailOf(u) ? '<button class="btn btn-primary btn-sm" data-action="chat-dm" data-person="' + esc(u.id) + '"><i class="fa-regular fa-message"></i><span class="label">Message</span><span class="spin"></span></button>' : '')
                : '<button class="btn btn-primary btn-sm" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in to message</button>'))) +
      '<button class="btn btn-outline btn-sm" type="button" data-action="card-share" data-kind="u" data-id="' + esc(u.id) + '"><i class="fa-solid fa-share-nodes"></i>Share</button>';

    return '<div class="page-head">' +
      '<div class="pv-avatar">' + avatar(u, 'avatar-lg pv-oct') +
      (u.video ? '<button type="button" class="profile-bg-btn pv-mute" data-action="profile-bg-mute" title="Unmute"><i class="fa-solid fa-volume-xmark"></i></button>' : '') +
      '</div>' +
      '<div class="info"><h1>' + esc(u.name) + '</h1>' +
      '<div class="person-name">' +
      (hasRoleU(u, 'mentor') ? '<span class="role-tag mentor"><i class="fa-solid fa-star"></i>Mentor</span>' : '') +
      (hasRoleU(u, 'catalyst') ? '<span class="role-tag catalyst"><i class="fa-solid fa-bolt"></i>Catalyst</span>' : '') +
      (hasRoleU(u, 'admin') ? '<span class="role-tag admin"><i class="fa-solid fa-shield-halved"></i>Organizer</span>' : '') + '</div>' +
      '<div class="meta-row">' +
      (u.affiliation ? '<span><i class="fa-solid fa-building"></i>' + esc(u.affiliation) + '</span>' : '') +
      (u.email ? '<span><i class="fa-regular fa-envelope"></i>' + esc(u.email) + '</span>' : '') +
      '</div>' +
      // the minted @designthinking.lk address, on its own line under the personal email
      (u.workEmail ? '<div class="meta-row"><span title="Workshop @designthinking.lk account"><i class="fa-regular fa-comment-dots"></i>' + esc(u.workEmail) + '</span></div>' : '') +
      '</div>' + // close .info
      // top-right: just the profile actions (Edit / Message / Share) — no box
      '<div class="pv-actions">' + actionBtns + '</div>' +
      '</div>' + // close .page-head
      // AI persona — how the community first meets this person. Written by Claude
      // from the public card fields; filled in async by initProfilePersona(). It
      // stands in for a manual "About", so no separate bio panel is shown.
      '<div class="panel pv-persona" id="pvPersona" hidden>' +
      '<h3><i class="fa-solid fa-wand-magic-sparkles"></i>Persona</h3>' +
      '<p class="pv-persona-text" id="pvPersonaText"></p></div>' +
      // Skills (left) and Teams (right) are equal-height cards; the link icons
      // sit under the Teams card in the right column.
      '<div class="pv-body">' +
      '<div class="pv-main">' +
      // No "mine" glow on the profile — on your own profile every chip would
      // glow (redundant); the highlight stays useful elsewhere (hive, skills map).
      ((u.skills || []).length ? '<div class="panel"><h3><i class="fa-solid fa-wand-magic-sparkles"></i>Skills</h3><div class="skills">' +
        u.skills.map(function (s) { return skillChip(s, false, true, true); }).join('') + '</div></div>' : '') +
      '</div>' +
      '<div class="pv-side">' +
      // Team/project associations are community-only. A public (signed-out)
      // visitor sees an invite prompt instead — the profile itself stays public.
      (signedIn()
        // Team name shown as plain text — the team page is preserved but not
        // linked/accessible from the profile for now.
        ? (myTeams.length ? '<div class="panel pv-teams"><h3><i class="fa-solid fa-people-group"></i>Teams</h3><ul class="link-list">' +
            myTeams.map(function (t) { return '<li><i class="fa-solid fa-people-group"></i><span style="color:var(--text-body)">' + esc(t.name) + '</span></li>'; }).join('') + '</ul></div>' : '')
        : '<div class="panel pub-invite pv-teams"><h3><i class="fa-solid fa-people-group"></i>Teams &amp; projects</h3>' +
            '<p style="color:var(--text-muted);margin:0 0 12px">Sign in to see this member’s team and project, or request an invite to join the ' + esc(eventName()) + ' community.</p>' +
            '<button class="btn btn-gradient btn-sm" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in</button></div>') +
      pvLinks +
      '</div>' +
      '</div>';
  }

  // ------------------------------------------------------- wallet pass

  /** iOS/iPadOS detection — iPadOS 13+ reports as MacIntel with touch. */
  function isApplePlatform_() {
    var ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) ||
           (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  }

  /** Panel on your own profile: a QR to add the live member card to your
   *  phone's wallet, plus a same-device button. Filled by initWalletPanel(). */
  function walletPanelHtml_() {
    return '<div class="panel wallet-panel" id="walletPanel">' +
      '<h3><i class="fa-solid fa-wallet"></i>Wallet card</h3>' +
      '<p class="wallet-lead">Add your ICE member card to your phone — it updates live with the program, your team and score.</p>' +
      '<div class="wallet-body"><div class="wallet-loading"><span class="spin"></span> Preparing your card…</div></div>' +
      '</div>';
  }

  function renderQr_(el, text) {
    try {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(5, 2);
      var img = el.querySelector('img');
      if (img) { img.style.width = '100%'; img.style.height = 'auto'; img.style.imageRendering = 'pixelated'; img.alt = 'Scan to add to wallet'; }
    } catch (e) {
      el.textContent = 'Could not render QR.';
    }
  }

  /** Button in the profile panel — opens the handoff page, which detects the
   *  device and offers Apple and/or Google. Same URL the QR encodes, so it
   *  works whether tapped here or scanned onto a phone. */
  function walletButtons_(handoffUrl) {
    return '<div class="wallet-btns">' +
      '<a class="btn-wallet btn-wallet-google" href="' + esc(handoffUrl) + '" target="_blank" rel="noopener">' +
      '<i class="fa-solid fa-wallet"></i><span>Add to wallet</span></a></div>';
  }

  /** Fills #walletPanel with a QR + button. Mints a short-lived wallet link. */
  function initWalletPanel() {
    var panel = $('#walletPanel');
    if (!panel) return;
    var body = panel.querySelector('.wallet-body');
    A.api('wallet_link', {}).then(function (r) {
      if (!r || !r.url) throw new Error('no url');
      body.innerHTML =
        '<div class="wallet-qr" id="walletQr"></div>' +
        '<div class="wallet-side">' +
        '<p class="wallet-scan">Scan with your phone camera, or tap below on your phone:</p>' +
        walletButtons_(r.url) + '</div>';
      renderQr_($('#walletQr'), r.url);
    }).catch(function () {
      body.innerHTML = '<p class="wallet-err">Could not prepare the wallet card. Please try again.</p>';
    });
  }

  // ---- Add-to-Wallet flyout on #/me: flips a QR into the persona space,
  //      auto-hiding after 10s of inactivity. QR is minted lazily on first open.
  var walletFlyoutTimer = null;
  function clearWalletFlyoutTimer() {
    if (walletFlyoutTimer) { clearTimeout(walletFlyoutTimer); walletFlyoutTimer = null; }
  }
  function resetWalletFlyoutTimer() {
    clearWalletFlyoutTimer();
    walletFlyoutTimer = setTimeout(hideWalletFlyout, 10000);
  }
  function hideWalletFlyout() {
    clearWalletFlyoutTimer();
    var fly = $('#walletFlyout'), persona = $('#personaPanel');
    if (fly) fly.hidden = true;
    if (persona) persona.hidden = false;
    restoreWalletButtons();
  }
  /** Restore the Save row + status and unfreeze the id card. */
  function restoreWalletButtons() {
    var join = $('#joinWrap'), status = $('#profileStatus'), left = $('.pf-left');
    if (join) join.hidden = false;
    if (status) status.hidden = false;
    if (left) left.classList.remove('pf-frozen');
  }
  // Reset the inactivity timer on any interaction inside the wallet block.
  function wireWalletActivity(el) {
    if (!el || el._wwired) return;
    el._wwired = true;
    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      el.addEventListener(ev, resetWalletFlyoutTimer, { passive: true });
    });
  }
  /** Fetch the Google/Apple save URLs and render them under the QR (same block). */
  function loadWalletPasses() {
    var passes = $('#walletPasses');
    if (!passes) return;
    Promise.all([
      A.api('wallet_pass', {}).then(function (r) { return r && r.url; }, function () { return null; }),
      A.api('apple_pass_link', {}).then(function (r) { return r && r.url; }, function () { return null; })
    ]).then(function (res) {
      if ($('#walletPasses') !== passes) return; // re-rendered meanwhile
      var g = res[0], a = res[1];
      var btnG = g ? '<a class="btn-wallet btn-wallet-google" href="' + esc(g) + '" target="_blank" rel="noopener"><i class="fa-brands fa-google-wallet"></i><span>Google Wallet</span></a>' : '';
      var btnA = a ? '<a class="btn-wallet btn-wallet-apple" href="' + esc(a) + '" target="_blank" rel="noopener"><i class="fa-brands fa-apple"></i><span>Apple Wallet</span></a>' : '';
      var order = isApplePlatform_() ? (btnA + btnG) : (btnG + btnA);
      passes.innerHTML = order || '<p class="wallet-err">Could not prepare your card. Please try again.</p>';
    });
  }
  function showWalletFlyout() {
    var fly = $('#walletFlyout'), persona = $('#personaPanel');
    if (!fly) return;
    if (persona) persona.hidden = true;
    fly.hidden = false;
    wireWalletActivity(fly);
    // hide the Save row + status and freeze the card so the wallet block can
    // stretch to the full column height (= the id card's height)
    var join = $('#joinWrap'), status = $('#profileStatus'), left = $('.pf-left');
    if (join) join.hidden = true;
    if (status) status.hidden = true;
    if (left) left.classList.add('pf-frozen');
    // mint the QR + wallet links once, then reuse
    if (!fly.getAttribute('data-loaded')) {
      fly.setAttribute('data-loaded', '1');
      A.api('wallet_link', {}).then(function (r) {
        if (!r || !r.url) throw new Error('no url');
        var slot = $('#walletQrSlot');
        if (slot) { slot.innerHTML = '<div class="wallet-qr" id="walletQr"></div>'; renderQr_($('#walletQr'), r.url); }
      }).catch(function () {
        var slot = $('#walletQrSlot');
        if (slot) slot.innerHTML = '<p class="wallet-err">Could not prepare the QR.</p>';
      });
      loadWalletPasses();
    }
    resetWalletFlyoutTimer();
  }

  /** #/wallet handoff page — the phone lands here after scanning the QR. The
   *  `wt` in the URL authenticates (the phone has no session token), so we ask
   *  wallet_pass for the Google save URL and hand off to the wallet app. */
  function viewWallet() {
    return '<div class="wallet-view" id="walletView">' +
      '<div class="wallet-hero">' +
      '<div class="wallet-mark"><i class="fa-solid fa-wallet"></i></div>' +
      '<h1>Your ICE member card</h1>' +
      '<p class="wallet-sub">Add it to your wallet — it updates live during the event.</p>' +
      '<div class="wallet-action"><div class="wallet-loading"><span class="spin"></span> Preparing your card…</div></div>' +
      '</div></div>';
  }

  function initWalletHandoff() {
    var view = $('#walletView');
    if (!view) return;
    var action = view.querySelector('.wallet-action');
    var m = (location.hash || '').match(/[?&]wt=([^&]+)/);
    var wt = m ? decodeURIComponent(m[1]) : '';
    var params = wt ? { wt: wt } : {};
    if (!wt && !signedIn()) {
      action.innerHTML = '<p class="wallet-err">This link is missing or expired. Open your profile and scan the QR again.</p>';
      return;
    }
    // Fetch both wallets; Apple silently drops out if not configured yet.
    var jobs = [
      A.api('wallet_pass', params).then(function (r) { return { google: r && r.url }; }, function () { return {}; }),
      A.api('apple_pass_link', params).then(function (r) { return { apple: r && r.url }; }, function () { return {}; }),
    ];
    Promise.all(jobs).then(function (rs) {
      var g = null, a = null;
      rs.forEach(function (x) { if (x.google) g = x.google; if (x.apple) a = x.apple; });
      var btnG = g ? '<a class="btn-wallet btn-wallet-google btn-wallet-lg" href="' + esc(g) + '"><i class="fa-brands fa-google-wallet"></i><span>Add to Google Wallet</span></a>' : '';
      var btnA = a ? '<a class="btn-wallet btn-wallet-apple btn-wallet-lg" href="' + esc(a) + '"><i class="fa-brands fa-apple"></i><span>Add to Apple Wallet</span></a>' : '';
      var apple = isApplePlatform_();
      // On Apple devices lead with the Apple button. Keep both as a fallback.
      var html = apple ? (btnA + btnG) : (btnG + btnA);
      action.innerHTML = html || '<p class="wallet-err">Could not prepare your card. Reopen the QR from your profile.</p>';
      // Phone: jump straight to the matching wallet (iOS → Apple, else Google).
      // One-shot per token so the back button returns to the buttons instead of
      // bouncing straight out again.
      var primary = apple ? (a || g) : (g || a);
      var phone = /Mobi|Android/i.test(navigator.userAgent) || apple;
      var jumped = false;
      try { jumped = sessionStorage.getItem('ice.wallet.jumped') === (wt || 'self'); } catch (e) {}
      if (primary && phone && !jumped) {
        try { sessionStorage.setItem('ice.wallet.jumped', wt || 'self'); } catch (e) {}
        location.href = primary;
      }
    });
  }

  /** #/pcard handoff — the phone lands here after scanning a shared project
   *  business card QR. The `wt` in the URL authenticates; we ask project_pass /
   *  apple_project_pass for the save URLs and hand off to the wallet app. */
  function viewProjectCard() {
    return '<div class="wallet-view" id="pcardView">' +
      '<div class="wallet-hero">' +
      '<div class="wallet-mark"><i class="fa-solid fa-id-card"></i></div>' +
      '<h1>ICE project card</h1>' +
      '<p class="wallet-sub">Add this project business card to your wallet.</p>' +
      '<div class="wallet-action"><div class="wallet-loading"><span class="spin"></span> Preparing the card…</div></div>' +
      '</div></div>';
  }

  function initProjectCardHandoff() {
    var view = $('#pcardView');
    if (!view) return;
    var action = view.querySelector('.wallet-action');
    var m = (location.hash || '').match(/[?&]wt=([^&]+)/);
    var wt = m ? decodeURIComponent(m[1]) : '';
    var params = wt ? { wt: wt } : {};
    if (!wt && !signedIn()) {
      action.innerHTML = '<p class="wallet-err">This card link is missing or expired.</p>';
      return;
    }
    Promise.all([
      A.api('project_pass', params).then(function (r) { return { google: r && r.url }; }, function () { return {}; }),
      A.api('apple_project_pass', params).then(function (r) { return { apple: r && r.url }; }, function () { return {}; })
    ]).then(function (rs) {
      var g = null, a = null;
      rs.forEach(function (x) { if (x.google) g = x.google; if (x.apple) a = x.apple; });
      var btnG = g ? '<a class="btn-wallet btn-wallet-google btn-wallet-lg" href="' + esc(g) + '"><i class="fa-brands fa-google-wallet"></i><span>Add to Google Wallet</span></a>' : '';
      var btnA = a ? '<a class="btn-wallet btn-wallet-apple btn-wallet-lg" href="' + esc(a) + '"><i class="fa-brands fa-apple"></i><span>Add to Apple Wallet</span></a>' : '';
      var apple = isApplePlatform_();
      action.innerHTML = (apple ? (btnA + btnG) : (btnG + btnA)) ||
        '<p class="wallet-err">Could not prepare this card.</p>';
      var primary = apple ? (a || g) : (g || a);
      var phone = /Mobi|Android/i.test(navigator.userAgent) || apple;
      var jumped = false;
      try { jumped = sessionStorage.getItem('ice.pcard.jumped') === (wt || 'self'); } catch (e) {}
      if (primary && phone && !jumped) {
        try { sessionStorage.setItem('ice.pcard.jumped', wt || 'self'); } catch (e) {}
        location.href = primary;
      }
    });
  }

  // ------------------------------------------------------------- teams

  function teamCard(t) {
    var members = (t.members || []).map(userById).filter(Boolean);
    var stack = members.slice(0, 5).map(function (m) { return avatar(m, 'avatar-sm'); }).join('');
    return '<a class="card team-card" href="#/team/' + esc(t.id) + '">' +
      '<div class="team-cover">' + (t.coverImage ? '<img src="' + esc(t.coverImage) + '" alt="" loading="lazy">' :
        '<span class="team-initial">' + esc(initials(t.name)) + '</span>') + '</div>' +
      '<div class="team-body"><h3 class="team-name">' + esc(t.name) + '</h3>' +
      (t.description ? '<p class="team-desc">' + esc(t.description) + '</p>' : '') +
      '<div class="team-meta"><span class="member-stack">' + stack + '</span>' +
      '<span>' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span></div>' +
      '</div></a>';
  }

  function viewTeams() {
    var d = state.data;
    if (!d) return skeletons();
    var teams = (d.teams || []).slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    var head = '<div class="section-head section-actions">' +
      (me() && (isCommunityMember(me()) || state.data.isAdmin) ? '<button class="btn btn-gradient btn-sm" data-action="new-team"><i class="fa-solid fa-plus"></i>Create team</button>' : '') + '</div>';
    if (!teams.length) {
      return head + '<div class="empty"><i class="fa-solid fa-people-group"></i>No teams yet.' +
        (me() && (isCommunityMember(me()) || state.data.isAdmin) ? '<br><br><button class="btn btn-gradient" data-action="new-team"><i class="fa-solid fa-plus"></i>Create the first team</button>' : ' Sign in to create the first one.') + '</div>';
    }
    return head + '<div class="grid grid-teams">' + teams.map(teamCard).join('') + '</div>';
  }

  var teamDetailCache = {};
  var teamEditing = null; // id of the team whose fields are being edited inline
  function viewTeam(id) {
    var t = null;
    (state.data && state.data.teams || []).forEach(function (x) { if (x.id === id) t = x; });
    if (!t) return state.loaded ? '<div class="empty"><i class="fa-solid fa-people-group"></i>Team not found.</div>' : skeletons();
    var detail = teamDetailCache[id];
    if (!detail) {
      A.api('team_detail', { teamId: id }).then(function (r) {
        teamDetailCache[id] = r;
        if (location.hash === '#/team/' + id) route();
      }).catch(function () {});
    }
    var members = (t.members || []).map(userById).filter(Boolean);
    var amMember = me() && (t.members || []).indexOf(me().id) !== -1;
    var canManage = me() && (t.creatorId === me().id || state.data.isAdmin);
    var editing = !!canManage && teamEditing === id; // inline edit mode

    var membersHtml = members.map(function (m) {
      return '<li>' + avatar(m, 'avatar-sm') + '<a href="#/profile/' + esc(m.id) + '" style="margin-left:8px">' + esc(m.name) + '</a></li>';
    }).join('');

    var linksHtml = detail ? (detail.links || []).map(function (l) {
      return '<li><i class="fa-solid fa-link"></i><div style="flex:1"><a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.title) + '</a>' +
        (l.description ? '<div style="font-size:13px;color:var(--text-muted)">' + esc(l.description) + '</div>' : '') + '</div>' +
        ((me() && (l.createdBy === me().id || canManage)) ? '<button class="btn btn-ghost btn-sm" data-action="del-link" data-id="' + esc(l.id) + '" data-team="' + esc(id) + '" title="Delete"><i class="fa-regular fa-trash-can"></i></button>' : '') +
        '</li>';
    }).join('') : '';

    var postsHtml = detail ? (detail.posts || []).slice().sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; }).map(function (p) {
      var author = userById(p.createdBy) || { name: 'Unknown' };
      return '<div class="feed-item">' + avatar(author, 'avatar-sm') +
        '<div class="body"><span class="who">' + esc(author.name) + '</span><span class="when">' + esc(timeAgo(p.createdAt)) + '</span>' +
        '<p>' + esc(p.content) + '</p></div></div>';
    }).join('') : '<div class="skeleton" style="height:70px"></div>';

    return '<div class="page-head">' +
      '<div class="info">' +
      (editing
        ? '<input class="input te-name" value="' + esc(t.name) + '" maxlength="100" placeholder="Team name" style="font-family:var(--font-display);font-size:30px;font-weight:800;letter-spacing:-0.02em;margin-bottom:4px">'
        : '<h1>' + esc(t.name) + '</h1>') +
      '<div class="meta-row"><span><i class="fa-solid fa-user-group"></i>' + members.length + ' members</span>' +
      '<span><i class="fa-regular fa-calendar"></i>Created ' + esc(fmtDate(t.createdAt)) + '</span></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      (editing
        ? '<button class="btn btn-gradient btn-sm" data-action="team-edit-save" data-id="' + esc(id) + '"><span class="label">Save changes</span><span class="spin"></span></button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-action="team-edit-cancel"><i class="fa-solid fa-xmark"></i>Cancel</button>'
        : (me()
            ? (isCommunityMember(me())
                ? (amMember
                    ? '<button class="btn btn-outline btn-sm" data-action="leave-team" data-id="' + esc(id) + '"><i class="fa-solid fa-arrow-right-from-bracket"></i><span class="label">Leave team</span><span class="spin"></span></button>'
                    : '<button class="btn btn-gradient btn-sm" data-action="join-team" data-id="' + esc(id) + '"><i class="fa-solid fa-plus"></i><span class="label">Join team</span><span class="spin"></span></button>')
                : '') // catalysts/organizers aren't team members — no join control
            : '<button class="btn btn-primary btn-sm" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in to join</button>') +
          (canManage ? '<button class="btn btn-outline btn-sm" data-action="edit-team" data-id="' + esc(id) + '"><i class="fa-solid fa-pen"></i>Edit</button>' : '')) +
      '</div></div></div>' +
      '<div class="detail-grid"><div>' +
      '<div class="panel" style="margin-bottom:20px"><h3><i class="fa-regular fa-file-lines"></i>About</h3>' +
      (editing
        ? '<textarea class="input te-desc" maxlength="3000" placeholder="Describe your team — what you’re building, your vision" style="min-height:90px">' + esc(t.description || '') + '</textarea>' +
          '<div class="field" style="margin:14px 0 0"><label>Looking for <span class="hint">skills or roles you need</span></label>' +
          '<input class="input te-looking" maxlength="500" value="' + esc(t.lookingFor || '') + '"></div>' +
          '<div class="field" style="margin:14px 0 0"><label>Cover image <span class="hint">optional</span></label>' +
          '<div class="photo-edit"><input type="hidden" name="coverImage" value="' + esc(t.coverImage || '') + '">' +
          '<img id="coverPreview" src="' + esc(t.coverImage || '') + '" alt="" style="height:56px;border-radius:8px;' + (t.coverImage ? '' : 'display:none') + '">' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="pick-image" data-target="coverImage" data-preview="coverPreview"><i class="fa-regular fa-image"></i><span class="label">Upload</span><span class="spin"></span></button></div></div>'
        : '<p style="white-space:pre-wrap;color:var(--text-body);margin:0">' + (t.description ? esc(t.description) : '<i>No description yet.</i>') + '</p>' +
          (t.lookingFor ? '<p style="margin:14px 0 0"><b>Looking for:</b> <span style="color:var(--color-accent-dark)">' + esc(t.lookingFor) + '</span></p>' : '')) +
      '</div>' +
      '<div class="panel"><h3><i class="fa-regular fa-comments"></i>Team feed</h3>' +
      '<div class="feed">' + (postsHtml || '<p style="color:var(--text-muted)">Nothing posted yet.</p>') + '</div>' +
      (amMember ? '<div class="thread-input" style="margin-top:16px"><textarea class="input" id="postInput" placeholder="Share an update with your team…"></textarea>' +
        '<button class="btn btn-primary" data-action="post-team" data-id="' + esc(id) + '"><span class="label"><i class="fa-regular fa-paper-plane"></i></span><span class="spin"></span></button></div>' : '') +
      '</div></div><div>' +
      '<div class="panel" style="margin-bottom:20px"><h3><i class="fa-solid fa-user-group"></i>Members</h3><ul class="link-list" style="gap:12px">' + membersHtml + '</ul></div>' +
      '<div class="panel"><h3><i class="fa-solid fa-link"></i>Links</h3>' +
      (linksHtml ? '<ul class="link-list">' + linksHtml + '</ul>' : '<p style="color:var(--text-muted);margin:0">No links yet.</p>') +
      (amMember ? '<button class="btn btn-outline btn-sm" style="margin-top:14px" data-action="add-link" data-id="' + esc(id) + '"><i class="fa-solid fa-plus"></i>Add link</button>' : '') +
      '</div></div></div>';
  }

  function teamForm(t) {
    t = t || {};
    modal('<h2>' + (t.id ? 'Edit team' : 'Create a team') + '</h2>' +
      '<form class="form" id="teamForm" data-id="' + esc(t.id || '') + '">' +
      '<div class="field"><label>Team name</label><input class="input" name="name" required maxlength="100" value="' + esc(t.name || '') + '"></div>' +
      '<div class="field"><label>Description</label><textarea class="input" name="description" maxlength="3000">' + esc(t.description || '') + '</textarea></div>' +
      '<div class="field"><label>Looking for <span class="hint">skills or roles you need</span></label><input class="input" name="lookingFor" maxlength="500" value="' + esc(t.lookingFor || '') + '"></div>' +
      '<div class="field"><label>Cover image <span class="hint">optional</span></label>' +
      '<div class="photo-edit"><input type="hidden" name="coverImage" value="' + esc(t.coverImage || '') + '">' +
      '<img id="coverPreview" src="' + esc(t.coverImage || '') + '" alt="" style="height:56px;border-radius:8px;' + (t.coverImage ? '' : 'display:none') + '">' +
      '<button type="button" class="btn btn-outline btn-sm" data-action="pick-image" data-target="coverImage" data-preview="coverPreview"><i class="fa-regular fa-image"></i><span class="label">Upload</span><span class="spin"></span></button></div></div>' +
      '<div class="form-status" id="teamFormStatus"></div>' +
      '<div class="form-actions"><button class="btn btn-gradient" type="submit"><span class="label">' + (t.id ? 'Save changes' : 'Create team') + '</span><span class="spin"></span></button>' +
      '<button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button></div></form>');
  }

  // ---------------------------------------------------------- announcements

  // Inline drafting card state: open + which announcement is being edited (null = new)
  var annDraft = { open: false, editing: null };

  function viewAnnouncements() {
    var d = state.data;
    if (!d) return skeletons();
    var canPost = canAnnounce();
    var anns = (d.announcements || []).slice().sort(function (a, b) {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
    var head = '<div class="section-head section-actions">' +
      (canPost && !annDraft.open ? '<button class="btn btn-gradient btn-sm" data-action="new-ann"><i class="fa-solid fa-plus"></i>New announcement</button>' : '') + '</div>';
    var draft = (canPost && annDraft.open) ? annDraftCard(annDraft.editing) : '';
    var list = anns.length
      ? anns.map(function (a) { return annCard(a, d); }).join('')
      : (annDraft.open ? '' : '<div class="empty"><i class="fa-solid fa-bullhorn"></i>No announcements yet.</div>');
    return head + draft + list;
  }

  function annCard(a, d) {
    var author = userById(a.authorId);
    var mine = me() && a.authorId === me().id;
    var canEdit = d.isAdmin || mine;
    return '<div class="card ann"><div class="ann-head">' +
      (a.isPinned ? '<span class="ann-pin" title="Pinned"><i class="fa-solid fa-thumbtack"></i></span>' : '') +
      '<h3>' + esc(a.title) + '</h3>' +
      '<span class="ann-type ' + esc(a.type) + '">' + esc(a.type) + '</span>' +
      (!a.isPublished ? '<span class="ann-type draft"><i class="fa-regular fa-pen-to-square"></i> draft</span>' : '') +
      '<span class="ann-date">' + (author ? esc(author.name) + ' · ' : '') + esc(timeAgo(a.createdAt)) + '</span>' +
      (canEdit ? '<span class="ann-actions"><button class="btn btn-ghost btn-sm" data-action="edit-ann" data-id="' + esc(a.id) + '"><i class="fa-solid fa-pen"></i></button>' +
        '<button class="btn btn-ghost btn-sm" data-action="del-ann" data-id="' + esc(a.id) + '"><i class="fa-regular fa-trash-can"></i></button></span>' : '') +
      '</div><p class="ann-body">' + esc(a.content) + '</p></div>';
  }

  // Full-width inline card (no modal) — draft, then Save / Discard / Send.
  function annDraftCard(a) {
    a = a || {};
    var d = state.data || {};
    var editing = !!a.id;
    var author = (me() && me().name) || '';
    return '<div class="card ann-draft">' +
      '<form class="form" id="annForm" data-id="' + esc(a.id || '') + '">' +
      '<div class="ann-draft-head"><h3><i class="fa-solid fa-bullhorn"></i>' + (editing ? 'Edit announcement' : 'New announcement') + '</h3>' +
      (author ? '<span class="ann-draft-author">Posting as ' + esc(author) + '</span>' : '') + '</div>' +
      '<div class="field"><label>Title</label><input class="input" name="title" required maxlength="200" value="' + esc(a.title || '') + '" placeholder="What&#39;s happening?"></div>' +
      '<div class="field"><label>Message</label><textarea class="input" name="content" required maxlength="5000" rows="5" placeholder="Write your announcement…">' + esc(a.content || '') + '</textarea></div>' +
      '<div class="form-row">' +
      '<div class="field"><label>Type</label><select class="input" name="type">' +
      ['general', 'important', 'urgent'].map(function (t) { return '<option' + (a.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
      '</select></div>' +
      (d.isAdmin ? '<div class="field"><label>Pinned</label><select class="input" name="isPinned"><option value="false">No</option><option value="true"' + (a.isPinned ? ' selected' : '') + '>Yes</option></select></div>' : '') +
      '</div>' +
      '<div class="form-status" id="annFormStatus"></div>' +
      '<div class="form-actions">' +
      '<button class="btn btn-gradient" type="submit"><span class="label"><i class="fa-regular fa-paper-plane"></i> Send</span><span class="spin"></span></button>' +
      '<button class="btn btn-outline" type="button" data-action="save-ann"><span class="label"><i class="fa-regular fa-floppy-disk"></i> Save draft</span><span class="spin"></span></button>' +
      '<button class="btn btn-ghost" type="button" data-action="discard-ann">Discard</button>' +
      '</div></form></div>';
  }

  function openAnnDraft(editing) {
    annDraft = { open: true, editing: editing || null };
    if (location.hash === '#/announcements') route(); else location.hash = '#/announcements';
  }

  async function submitAnn(form, publish, btn) {
    var status = $('#annFormStatus');
    if (status) { status.className = 'form-status'; status.textContent = ''; }
    var fd = new FormData(form);
    var title = String(fd.get('title') || '').trim();
    var content = String(fd.get('content') || '').trim();
    if (!title || !content) { if (status) status.textContent = 'Title and message are required.'; return; }
    busy(btn, true);
    var annId = form.getAttribute('data-id');
    var body = {
      title: title, content: content,
      type: fd.get('type') || 'general',
      isPinned: fd.get('isPinned') === 'true',
      isPublished: publish,
    };
    try {
      annId ? await A.api('ann_update', Object.assign({ id: annId }, body))
            : await A.api('ann_create', body);
      annDraft = { open: false, editing: null };
      await refresh();
      route();
      toast(publish ? 'Announcement sent' : 'Draft saved');
    } catch (err) {
      if (status) status.textContent = err.message || 'Something went wrong.';
      busy(btn, false);
    }
  }

  // ------------------------------------------------------ register / edit

  /** Form select/suggestion options — fetched from the Google Sheet via
   *  bootstrap ("options" tab); config lists are only the offline fallback. */
  function opts(category, fallback) {
    var o = state.data && state.data.options;
    return (o && o[category] && o[category].length) ? o[category] : fallback;
  }
  function formReady() { return !!(state.data && state.data.options); }
  function formLoading() {
    return '<div class="form-loading"><span class="spin"></span>Preparing the form…</div>';
  }

  // ---- photo editor (drag to adjust, scroll/pinch to zoom) ----
  // State model: (cx, cy) = natural-image point at the viewport center,
  // s = displayed px per natural px. Baked to a 512px square on submit.
  var photoEd = null;

  function photoLoad(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var vp = $('#photoVp');
      if (!vp) return;
      photoEd = {
        img: img, iw: img.naturalWidth, ih: img.naturalHeight,
        cx: img.naturalWidth / 2, cy: img.naturalHeight / 2, s: 0, minS: 0,
      };
      vp.innerHTML = '<img id="photoImg" src="' + url + '" alt="" draggable="false">' +
        '<button type="button" class="photo-change" data-action="photo-pick" title="Change photo"><i class="fa-solid fa-camera"></i></button>';
      photoEd.minS = vp.clientWidth / Math.min(photoEd.iw, photoEd.ih);
      photoEd.s = photoEd.minS;
      photoPaint();
      wirePhotoGestures(vp);
      updateJoinState(); // a photo now exists — may complete the form
    };
    img.src = url;
  }

  function photoClamp() {
    var vp = $('#photoVp');
    if (!vp || !photoEd) return;
    var V = vp.clientWidth, e = photoEd;
    e.s = Math.max(e.minS, Math.min(e.minS * 8, e.s));
    var half = V / (2 * e.s);
    e.cx = Math.max(half, Math.min(e.iw - half, e.cx));
    e.cy = Math.max(half, Math.min(e.ih - half, e.cy));
  }

  function photoPaint() {
    var vp = $('#photoVp'), img = $('#photoImg');
    if (!vp || !img || !photoEd) return;
    photoClamp();
    var V = vp.clientWidth, e = photoEd;
    img.style.maxWidth = 'none';
    img.style.width = (e.iw * e.s) + 'px';
    img.style.left = (V / 2 - e.cx * e.s) + 'px';
    img.style.top = (V / 2 - e.cy * e.s) + 'px';
  }

  function wirePhotoGestures(vp) {
    var pts = {}, lastDist = 0;
    vp.addEventListener('pointerdown', function (ev) {
      if (!photoEd || ev.target.closest('[data-action]')) return;
      ev.preventDefault();
      vp.setPointerCapture(ev.pointerId);
      pts[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      lastDist = 0;
    });
    vp.addEventListener('pointermove', function (ev) {
      if (!photoEd || !pts[ev.pointerId]) return;
      var ids = Object.keys(pts);
      if (ids.length === 1) {           // one finger / mouse: pan
        var p = pts[ev.pointerId];
        photoEd.cx -= (ev.clientX - p.x) / photoEd.s;
        photoEd.cy -= (ev.clientY - p.y) / photoEd.s;
        p.x = ev.clientX; p.y = ev.clientY;
        photoPaint();
      } else if (ids.length === 2) {    // two fingers: pinch zoom
        pts[ev.pointerId].x = ev.clientX; pts[ev.pointerId].y = ev.clientY;
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
        if (lastDist) { photoEd.s *= d / lastDist; photoPaint(); }
        lastDist = d;
      }
    });
    function up(ev) { delete pts[ev.pointerId]; lastDist = 0; }
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('wheel', function (ev) {
      if (!photoEd) return;
      ev.preventDefault();
      photoEd.s *= Math.exp(-ev.deltaY * 0.0015);
      photoPaint();
    }, { passive: false });
  }

  function photoBake() {
    var vp = $('#photoVp');
    photoClamp();
    var V = vp.clientWidth, e = photoEd;
    var win = V / e.s; // visible window size in natural px
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    canvas.getContext('2d').drawImage(e.img, e.cx - win / 2, e.cy - win / 2, win, win, 0, 0, 512, 512);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  // ---- intro / pitch video: shared upload + validation ----
  // Uploaded clips must be Full-HD landscape (1920×1080), ≤60s and ≤32 MB. The
  // Apps Script upload path (a single base64 POST) tops out near 32 MB, so we
  // reject anything larger in the browser before it is ever sent; the same caps
  // live server-side as a backstop.
  var VIDEO_MAX_BYTES = 32 * 1024 * 1024;
  var VIDEO_MAX_SECONDS = 60.5;
  var VIDEO_REQ_W = 1920, VIDEO_REQ_H = 1080;

  // The requirements notice shown inside every upload panel.
  function videoReqHtml() {
    return '<div class="vid-req"><i class="fa-solid fa-circle-info"></i>' +
      '<span>Upload a <b>Full-HD 1920×1080</b> landscape clip, <b>up to 60 seconds</b>, <b>max 32 MB</b>. ' +
      'Portrait or higher-resolution videos aren’t accepted.</span></div>';
  }

  // Build <source> tags for a stored video. Google Drive refuses to serve a
  // video to a browser <video> (the lh3 URL returns a JPEG poster; the direct
  // download URL is blocked cross-origin), so Drive clips stream through our
  // Cloudflare Worker proxy (/vid/<id>), which fetches the file server-side and
  // relays it with byte-range support. A bundled asset path is used as-is.
  var MEDIA_PROXY = 'https://ice-central-web-proxy.sankha-9a1.workers.dev/vid/';
  function driveVideoStreamUrl(id) { return MEDIA_PROXY + id; }
  function videoSourcesHtml(url) {
    var m = String(url).match(/\/d\/([^/?]+)/) || String(url).match(/[?&]id=([^&]+)/);
    var id = m ? m[1] : '';
    // no type= hint: the endpoint returns the real Content-Type, so the browser
    // sniffs it (works for mp4 and webm uploads alike)
    return '<source src="' + esc(id ? driveVideoStreamUrl(id) : url) + '">';
  }

  // Validate a picked File against the rules; report progress/errors through
  // setStatus(msg, isErr) and call onOk(file) only when everything passes.
  function validateVideoFile(file, setStatus, onOk) {
    if (!file) return;
    if (!/^video\//.test(file.type || '')) return setStatus('Please choose a video file (MP4 or WebM).', true);
    if (file.size > VIDEO_MAX_BYTES) return setStatus('Video is ' + (file.size / 1024 / 1024).toFixed(1) + ' MB — must be under 32 MB.', true);
    setStatus('Checking video…', false);
    var url = URL.createObjectURL(file);
    var probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = function () {
      var dur = probe.duration, w = probe.videoWidth, h = probe.videoHeight;
      URL.revokeObjectURL(url);
      if (!isFinite(dur) || !w || !h) return setStatus('Could not read the video. Try an MP4.', true);
      if (w !== VIDEO_REQ_W || h !== VIDEO_REQ_H) {
        return setStatus('Video is ' + w + '×' + h + ' — must be Full-HD 1920×1080 (landscape).', true);
      }
      if (dur > VIDEO_MAX_SECONDS) return setStatus('Video is ' + Math.round(dur) + 's — must be 60 seconds or less.', true);
      onOk(file);
    };
    probe.onerror = function () { URL.revokeObjectURL(url); setStatus('Could not read that video. Try an MP4.', true); };
    probe.src = url;
  }

  // Open a file picker and run the choice through validation.
  function pickVideoFile(setStatus, onOk) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/webm,video/quicktime,video/ogg,video/*';
    input.onchange = function () { validateVideoFile(input.files && input.files[0], setStatus, onOk); };
    input.click();
  }

  // ---- profile intro video: upload panel (inside the card overlay) ----

  // display name of the currently-shown intro clip (the file the member just
  // picked). '' when nothing uploaded this session; reset when the form rebuilds.
  var profileVideoName = '';
  // true while an upload/removal request is in flight — warns before a reload
  // (the server request runs to completion regardless, so a refresh never leaves
  // a half-done state; it just abandons the client's view of the result).
  var videoActionPending = false;
  window.addEventListener('beforeunload', function (e) {
    if (!videoActionPending) return;
    e.preventDefault();
    e.returnValue = 'A video upload or removal is still finishing. If you leave now the change may not complete.';
    return e.returnValue;
  });

  function profileVideoUrl() {
    var hid = $('#profileForm [name="video"]');
    return (hid && hid.value) || '';
  }

  function videoPanelHtml() {
    var has = !!profileVideoUrl();
    var name = profileVideoName || (has ? 'Your intro clip' : '');
    // Top slot: the requirements guide until a valid clip is present, then the
    // "now playing" clip name takes its exact place.
    var top = has
      ? '<div class="vid-now"><i class="fa-solid fa-circle-play"></i><div class="vid-now-txt">' +
          '<span class="vid-now-label">Playing on your card</span>' +
          '<span class="vid-now-name" title="' + esc(name) + '">' + esc(name) + '</span></div></div>'
      : videoReqHtml();
    // Footer pinned to the card's bottom edge (the "virtual footer", level with
    // the card's own footer row). The status sits on top; the action buttons and
    // the progress bar share the very bottom line — buttons when idle, the bar
    // during a transfer (they're never shown at once).
    var foot =
      '<div class="vid-foot">' +
        '<div class="vid-status" id="profileVideoStatus"></div>' +
        '<div class="vid-actions" id="profileVideoActions">' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="profile-video-pick"><i class="fa-solid fa-upload"></i>' + (has ? 'Replace video' : 'Upload video') + '</button>' +
          (has ? '<button type="button" class="btn btn-ghost btn-sm" data-action="profile-video-remove"><i class="fa-regular fa-trash-can"></i>Remove</button>' : '') +
        '</div>' +
        '<div class="vid-progress" id="profileVideoProgress" hidden><div class="vid-progress-bar" id="profileVideoBar"></div></div>' +
      '</div>';
    return top + foot;
  }

  function renderVideoPanel() {
    var box = $('#ytCard');
    if (box) box.innerHTML = videoPanelHtml();
  }

  function profileVideoStatus(msg, isErr) {
    var el = $('#profileVideoStatus');
    if (el) { el.textContent = msg; el.className = 'vid-status' + (isErr ? ' err' : ''); }
    if (isErr) toast(msg, true);
  }

  function setVideoProgress(pct, indeterminate) {
    var wrap = $('#profileVideoProgress'), bar = $('#profileVideoBar');
    if (!wrap || !bar) return;
    wrap.hidden = false;
    wrap.classList.toggle('indet', !!indeterminate);
    bar.style.width = indeterminate ? '' : (Math.max(0, Math.min(100, pct)) + '%');
    var acts = $('#profileVideoActions'); if (acts) acts.hidden = true; // hide buttons mid-transfer
  }
  function hideVideoProgress() {
    var wrap = $('#profileVideoProgress');
    if (wrap) { wrap.hidden = true; wrap.classList.remove('indet'); }
    var acts = $('#profileVideoActions'); if (acts) acts.hidden = false;
  }

  function pickProfileVideo() {
    pickVideoFile(profileVideoStatus, uploadProfileVideo);
  }

  // Apps Script requires a "simple" CORS request (no preflight), which rules out
  // XHR upload-progress events (registering one forces an OPTIONS preflight that
  // Apps Script can't answer). So we send with fetch and show an indeterminate
  // "working" bar for the whole upload+process window rather than a byte %.
  function uploadProfileVideo(file) {
    profileVideoStatus('Preparing…', false);
    var reader = new FileReader();
    reader.onload = function () {
      videoActionPending = true;
      setVideoProgress(0, true); // indeterminate — the request covers upload + server processing
      profileVideoStatus('Uploading your clip… keep this page open (this can take up to a minute).', false);
      A.api('upload_profile_video', { data: reader.result, filename: file.name.replace(/\.[^.]+$/, ''), videoName: file.name })
        .then(function (r) {
          videoActionPending = false;
          var hid = $('#profileForm [name="video"]');
          if (hid && r && r.url) hid.value = r.url;
          profileVideoName = file.name;
          // the server persists the clip immediately (existing member) — mirror
          // that into cached state so the card + profile page reflect it now and
          // it needs no separate Save
          if (r && r.user && state.data) {
            if (state.data.me && state.data.me.id === r.user.id) state.data.me = r.user;
            if (state.data.users) state.data.users = state.data.users.map(function (u) {
              return u.id === r.user.id ? Object.assign({}, u, { video: r.url, videoName: file.name }) : u;
            });
            A.writeCache(state.data);
          }
          hideVideoProgress();
          profileVideoStatus('', false);
          renderVideoPanel();
          renderCardVideo(); // the card backdrop follows the picked video live
          updateJoinState();
          saveRegDraft();
          toast('Video uploaded');
        })
        .catch(function (err) { videoActionPending = false; hideVideoProgress(); profileVideoStatus(err.message || 'Upload failed', true); });
    };
    reader.onerror = function () { profileVideoStatus('Could not read the file.', true); };
    reader.readAsDataURL(file);
  }

  // Remove the intro clip: delete it from Drive on the server, clear the field,
  // and revert the card to the default backdrop. Shows the same progress/status
  // treatment as upload. The server clears the row before deleting the blob, so
  // a failed/aborted call never leaves a row pointing at a missing file.
  function removeProfileVideo() {
    var hid = $('#profileForm [name="video"]');
    var url = hid && hid.value;
    if (!url) { profileVideoName = ''; renderVideoPanel(); renderCardVideo(); return; }
    videoActionPending = true;
    setVideoProgress(0, true);
    profileVideoStatus('Removing your clip from the server… keep this page open.', false);
    A.api('remove_profile_video', { url: url })
      .then(function (r) {
        videoActionPending = false;
        if (hid) hid.value = '';
        profileVideoName = '';
        // reflect the cleared video in cached state so the card + profile page
        // both fall back to the default straight away
        if (r && r.user && state.data) {
          if (state.data.me && state.data.me.id === r.user.id) state.data.me = r.user;
          if (state.data.users) state.data.users = state.data.users.map(function (u) {
            return u.id === r.user.id ? Object.assign({}, u, { video: '', videoName: '' }) : u;
          });
          A.writeCache(state.data);
        }
        hideVideoProgress();
        renderVideoPanel();
        renderCardVideo(); // default backdrop plays
        updateJoinState();
        saveRegDraft();
        profileVideoStatus('', false);
        toast('Video removed — default backdrop restored');
      })
      .catch(function (err) {
        videoActionPending = false;
        hideVideoProgress();
        // the removal may actually have completed server-side even if the reply
        // didn't reach us — tell the user how to confirm rather than guessing
        profileVideoStatus('Couldn’t confirm removal (' + (err.message || 'network error') + '). Reload the page to check whether it was removed.', true);
      });
  }

  // ---- profile page: the member's intro clip as a full-screen backdrop ----
  // When a member has uploaded a clip, it auto-plays (muted, so autoplay is
  // always allowed) as a feathered, faded, full-screen backdrop behind the
  // profile content — the same treatment as the home-screen video. Lives in
  // .main so it survives the #view repaint on data refreshes; a floating button
  // unmutes it. Left when navigating away (see route()).
  var profileBg = null, profileBgHash = '';
  function playProfileBg(src) {
    stopProfileBg();
    var main = document.querySelector('.main');
    if (!main || !src) return;
    var layer = document.createElement('div');
    layer.className = 'profile-bg-video';
    // the unmute control lives in the profile header (rendered by viewProfile,
    // anchored to the avatar), not in this pointer-events:none backdrop layer
    layer.innerHTML =
      '<video id="profileBgEl" autoplay loop muted playsinline preload="auto">' + videoSourcesHtml(src) + '</video>' +
      '<div class="profile-bg-scrim"></div>';
    main.insertBefore(layer, main.firstChild);
    document.body.classList.add('profile-bg-on');
    profileBg = layer;
    profileBgHash = location.hash || '';
    var v = $('#profileBgEl');
    if (v) {
      v.muted = true; // page backdrop — muted guarantees autoplay; button unmutes
      var reveal = function () { if (layer.parentNode) layer.classList.add('show'); };
      v.addEventListener('playing', reveal, { once: true });
      v.addEventListener('loadeddata', reveal, { once: true });
      setTimeout(reveal, 1600); // safety net so it never stays hidden
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    }
    setProfileBgMuteIcon();
  }
  function stopProfileBg() {
    if (profileBg && profileBg.parentNode) profileBg.parentNode.removeChild(profileBg);
    profileBg = null; profileBgHash = '';
    document.body.classList.remove('profile-bg-on');
  }
  function setProfileBgMuteIcon() {
    var v = $('#profileBgEl');
    var btn = $('[data-action="profile-bg-mute"]'); // in the profile header
    if (!v || !btn) return;
    btn.innerHTML = '<i class="fa-solid ' + (v.muted ? 'fa-volume-xmark' : 'fa-volume-high') + '"></i>';
    btn.title = v.muted ? 'Unmute' : 'Mute';
  }

  // ---- intro video as the card backdrop ----
  // The video fills the card above the footer row (~16:9 there), on loop at
  // reduced opacity so the card gradient tints through. When the member has
  // no intro video, a bundled default loop plays instead — display-only, never
  // written into the form's video field. The backdrop starts muted so autoplay
  // is always allowed; the footer speaker button toggles the <video> directly.
  var DEFAULT_CARD_VIDEO = 'assets/video/default-card-bg.mp4?v=3';
  // start with sound on; renderCardVideo falls back to muted only if the browser
  // blocks an unmuted autoplay (no user gesture yet)
  var cardVideoMuted = false;
  // whether the user themselves chose mute (via the speaker button) — distinct
  // from a mute the browser's autoplay policy forced on a cold page load
  var cardUserMuted = false;
  var cardAudioUnlockArmed = false;

  // no `autoplay` attribute — we start playback ourselves once the clip has
  // buffered enough, so the opening (its most important notes) isn't clipped by
  // a mid-buffer start. See startCardVideo.
  function cardVideoTag(src) {
    return '<video id="cardVideoEl" loop playsinline preload="auto"' +
      (cardVideoMuted ? ' muted' : '') + '>' + videoSourcesHtml(src) + '</video>';
  }

  // Audio fade-in: browsers can drop the first fraction of a second of audio on
  // a cold start (and again after the loop wraps). Rather than fight it, ramp
  // volume 0→1 over ~1.6s so those opening samples land during near-silence and
  // the "cut" is inaudible. Applied on first play and on every loop restart.
  var CARD_AUDIO_FADE_MS = 1600;
  function fadeCardAudioIn(v) {
    if (!v) return;
    clearInterval(v.__volTimer);
    var steps = 32, i = 0;
    try { v.volume = 0; } catch (e) { /* ignore */ }
    v.__volTimer = setInterval(function () {
      i++;
      try { v.volume = Math.min(1, i / steps); } catch (e) { /* ignore */ }
      if (i >= steps) { clearInterval(v.__volTimer); v.__volTimer = null; }
    }, CARD_AUDIO_FADE_MS / steps);
  }
  // Re-run the fade each time the loop wraps back to the start (currentTime jumps
  // backwards), so the opening cut is masked on every repeat, not just the first.
  function wireCardLoopFade(v) {
    if (v.__loopWired) return;
    v.__loopWired = true;
    var last = 0;
    v.addEventListener('timeupdate', function () {
      var t = v.currentTime;
      if (t + 0.1 < last && !v.muted) fadeCardAudioIn(v);
      last = t;
    });
  }
  // Play the card video unmuted with the audio fade-in. If the browser blocks
  // unmuted playback (cold load, no gesture) fall back to muted and unmute on
  // the first user interaction.
  function playCardUnmuted(v) {
    v.muted = false;
    fadeCardAudioIn(v);
    var p = v.play();
    if (p && p.catch) p.catch(function () {
      clearInterval(v.__volTimer); v.__volTimer = null; try { v.volume = 1; } catch (e) {}
      v.muted = true; cardVideoMuted = true; setCardMuteIcon();
      v.play().catch(function () {});
      armCardAudioUnlock();
    });
  }
  // Wait until enough is buffered to play through (canplaythrough, capped so a
  // slow network still starts within ~2.5s), then play from the beginning.
  function startCardVideo(v) {
    var started = false;
    function begin() {
      if (started || !v.isConnected) return;
      started = true;
      try { v.currentTime = 0; } catch (e) { /* plays from 0 anyway */ }
      wireCardLoopFade(v);
      if (cardVideoMuted) {
        v.muted = true;
        var pm = v.play(); if (pm && pm.catch) pm.catch(function () {});
        return;
      }
      playCardUnmuted(v);
    }
    if (v.readyState >= 4) { begin(); return; }     // HAVE_ENOUGH_DATA already
    v.addEventListener('canplaythrough', begin, { once: true });
    setTimeout(begin, 2500);                         // safety cap on the buffer wait
  }

  // The browser only allows unmuted playback after a user gesture. When a cold
  // load forced the card video muted, unmute it on the first click/tap/key —
  // unless the user has since chosen mute themselves. One-shot.
  function armCardAudioUnlock() {
    if (cardAudioUnlockArmed) return;
    cardAudioUnlockArmed = true;
    function unlock() {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      cardAudioUnlockArmed = false;
      var v = $('#cardVideoEl');
      if (!v || cardUserMuted || !cardVideoMuted) return; // gone, or mute is intended
      cardVideoMuted = false;
      playCardUnmuted(v); // unmute + fade the audio in
      setCardMuteIcon();
    }
    // capture phase so it runs before the card's own click handlers
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    document.addEventListener('touchstart', unlock, true);
  }

  function renderCardVideo() {
    var box = $('#cardVideo');
    if (!box) return;
    var own = profileVideoUrl();
    var src = own || DEFAULT_CARD_VIDEO; // fallback backdrop, never saved
    var muteBtn = $('#cardMuteBtn');
    var label = $('#cardVideoLabel');
    if (label) label.textContent = own ? '' : 'Add video';
    if (muteBtn) muteBtn.hidden = false;
    // only rebuild when the source actually changed, so re-renders don't
    // restart playback
    if (box.getAttribute('data-vid') !== src) {
      box.setAttribute('data-vid', src);
      box.innerHTML = cardVideoTag(src);
      var v = $('#cardVideoEl');
      if (v) {
        v.muted = cardVideoMuted;
        startCardVideo(v); // buffer first, then play from the very beginning
      }
    }
    setCardMuteIcon();
  }

  function setCardMuteIcon() {
    var btn = $('#cardMuteBtn');
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid ' + (cardVideoMuted ? 'fa-volume-xmark' : 'fa-volume-high') + '"></i>';
    btn.title = cardVideoMuted ? 'Unmute video' : 'Mute video';
  }

  // Add/replace the intro video — the upload panel lives in an inline overlay on
  // the card front, opened from the footer's video button.
  function openVideoOverlay() {
    var ov = $('#videoOverlay');
    if (!ov) return;
    renderVideoPanel();
    ov.hidden = false;
  }

  function closeVideoOverlay() {
    var ov = $('#videoOverlay');
    if (ov) ov.hidden = true;
  }

  // ---- validation ----

  function normUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    return v;
  }

  // A bare handle in the GitHub / LinkedIn field ("sankha" or "@sankha")
  // completes to the full profile URL before checking, validating and saving.
  var LINK_PREFIX = { linkGithub: 'github.com/', linkLinkedin: 'linkedin.com/in/' };
  function completeLink(field, v) {
    v = String(v || '').trim();
    var pre = LINK_PREFIX[field];
    if (!pre || !v) return v;
    var handle = v.replace(/^@/, '');
    // anything with a dot, slash or space is already URL-ish — leave it alone
    if (/[/.\s]/.test(handle)) return v;
    return pre + handle;
  }

  // The GitHub / LinkedIn fields show the fixed part ("github.com/") as static
  // text and only take the username. Given anything — a bare handle, a full URL
  // someone pasted, "@name", "www.linkedin.com/in/name/" — reduce it to just the
  // username so the input mirrors what sits after the prefix.
  function linkHandle(field, v) {
    v = String(v || '').trim();
    if (!v || (field !== 'linkGithub' && field !== 'linkLinkedin')) return v;
    v = v.replace(/^@/, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    if (field === 'linkGithub') {
      v = v.replace(/^github\.com\//i, '');
    } else {
      v = v.replace(/^linkedin\.com\//i, '').replace(/^(in|pub)\//i, '');
    }
    // keep only the first path segment (the profile handle), drop query/hash
    return v.split(/[?#]/)[0].split('/')[0];
  }

  function validateProfile(form) {
    var fd = new FormData(form);
    if (!String(fd.get('firstName') || '').trim()) return 'Please enter your first name.';
    // GitHub is mandatory for builders (participants/mentors). Someone without an
    // account types the bypass keyword (C.GITHUB_BYPASS) to satisfy it — they
    // won't be added to the GitHub org. Catalysts (guests) are exempt.
    var isCatalystCard = form.getAttribute('data-role') === 'catalyst';
    var ghRaw = String(fd.get('linkGithub') || '').trim();
    var ghWaiver = String(C.GITHUB_BYPASS || '');
    var ghBypassed = isCatalystCard || (!!ghWaiver && ghRaw.toLowerCase() === ghWaiver.toLowerCase());
    if (!isCatalystCard && !ghRaw) {
      return ghWaiver
        ? 'A GitHub username is required. If you don’t have one, type “' + ghWaiver + '” to skip.'
        : 'A GitHub username is required.';
    }
    var linkRules = [
      ['linkGithub', /(^|\.)github\.com$/i, 'GitHub'],
      ['linkWebsite', null, 'Website'],
      ['linkLinkedin', /(^|\.)linkedin\.com$/i, 'LinkedIn'],
    ];
    for (var i = 0; i < linkRules.length; i++) {
      if (linkRules[i][0] === 'linkGithub' && ghBypassed) continue; // waiver keyword
      var v = normUrl(completeLink(linkRules[i][0], fd.get(linkRules[i][0])));
      if (!v) continue;
      var host = '';
      try { host = new URL(v).hostname; } catch (e) { /* invalid */ }
      if (!host || host.indexOf('.') === -1) return linkRules[i][2] + ' link is not a valid URL.';
      if (linkRules[i][1] && !linkRules[i][1].test(host)) {
        return linkRules[i][2] + ' link should point to ' + linkRules[i][2].toLowerCase() + '.com.';
      }
    }
    // Intro video is validated at upload time (resolution/length/size) and only
    // a Drive URL ever reaches the hidden field, so there's nothing to check here.
    return null;
  }

  // The card's role is pre-assigned — by the invite for a new registration
  // (bootstrap.invite, mirrored server-side), by the stored role chips when
  // editing — so the badge is fixed; there is nothing to choose.
  function cardRole(u, isNew) {
    if (!isNew) return hasRoleU(u, 'admin') ? 'admin' : hasRoleU(u, 'mentor') ? 'mentor' : hasRoleU(u, 'catalyst') ? 'catalyst' : 'participant';
    var d = state.data || {};
    if (d.invite) return PLATFORM_ROLES.indexOf(d.invite.role) !== -1 ? d.invite.role : 'participant';
    return d.isAdmin ? 'admin' : 'participant';
  }

  function profileForm(u, isNew) {
    u = u || {};
    // split stored links into the three card fields by hostname
    var lg = '', lw = '', ll = '';
    (u.links || []).forEach(function (l) {
      var s = String(l);
      if (/github\.com/i.test(s) && !lg) lg = s;
      else if (/linkedin\.com/i.test(s) && !ll) ll = s;
      else if (!lw) lw = s;
    });
    var skills = (u.skills || []);
    var gender = u.gender || '';
    // only a Drive-hosted clip is carried into the editor; legacy YouTube links
    // are dropped (the member re-uploads), so the default backdrop shows instead
    var vid = /^https:\/\/(lh3\.googleusercontent\.com|drive\.(google|usercontent\.google)\.com)\//.test(u.video || '') ? u.video : '';
    profileVideoName = vid ? (u.videoName || '') : ''; // stored clip name, if any
    // The card edits first + last separately; they recombine into the stored `name`.
    var nameParts = String(u.name || '').trim().split(/\s+/).filter(Boolean);
    var firstName = nameParts.shift() || '';
    var lastName = nameParts.join(' ');
    var role = cardRole(u, isNew);

    return '<form class="form pf-grid" id="profileForm" data-new="' + (isNew ? '1' : '') + '" data-role="' + role + '">' +

      '<div class="pf-left">' +
      '<div class="idcard-scene">' +
      // submit overlay — blocks card interaction while the request is in flight
      '<div class="card-busy" id="cardBusy" hidden><span class="spin"></span></div>' +
      '<div class="idcard" id="idcard">' +

      // ---------------- front
      '<div class="idface idfront">' +
      // intro video plays as the card's backdrop (everything above the footer)
      '<div class="card-video" id="cardVideo"></div>' +
      '<div class="idcard-head"><span class="idcard-brand">' + brandHtml(true) + '</span>' +
      // role badge is fixed (pre-assigned by the invite / role chips)
      '<span class="idcard-type">' + (role === 'admin' ? 'ORGANIZER' : role === 'mentor' ? 'MENTOR' : role === 'catalyst' ? 'CATALYST' : 'MEMBER') + '</span>' +
      '</div>' +
      '<div class="idcard-main">' +
      '<div class="idcard-photo"><div class="photo-vp" id="photoVp" title="Drag to adjust · scroll to zoom">' +
      (u.image
        ? '<img class="photo-static" src="' + esc(u.image) + '" alt="">'
        : '<div class="photo-empty" data-action="photo-pick"><i class="fa-solid fa-camera"></i><span>Add photo</span></div>') +
      '<button type="button" class="photo-change" data-action="photo-pick" title="Change photo"><i class="fa-solid fa-camera"></i></button>' +
      '</div></div>' +
      '<div class="idcard-fields">' +
      '<div class="cname-row">' +
      '<span class="cgender"><i class="fa-solid fa-user"></i></span>' +
      '<input class="cinput cname" name="firstName" required maxlength="25" placeholder="First name" value="' + esc(firstName) + '">' +
      '<input class="cinput cname" name="lastName" maxlength="25" placeholder="Last name" value="' + esc(lastName) + '">' +
      '</div>' +
      '<input type="hidden" name="gender" value="' + esc(gender) + '">' +
      // registration: live-proposed handle (hidden until a name is typed);
      // edit: the member's minted workshop address, shown as-is
      '<div class="cemail" id="proposedEmail"' + (!isNew && u.workEmail ? '' : ' hidden') + '>' +
      '<i class="fa-regular fa-envelope"></i>' +
      '<span class="cemail-addr" id="cemailAddr">' + esc(!isNew && u.workEmail ? u.workEmail : '') + '</span>' +
      '<span class="cemail-status" id="cemailStatus" data-status=""></span></div>' +
      '<label class="cfield"><i class="fa-solid fa-building"></i><input class="cinput" name="affiliation" maxlength="45" placeholder="Affiliation — university, company" value="' + esc(u.affiliation || '') + '"></label>' +
      '</div></div>' + // close .idcard-fields + .idcard-main
      // skills attach directly on the card front (max 3, one line)
      '<div class="idcard-skills">' +
      '<i class="fa-solid fa-wand-magic-sparkles cskill-lead"></i>' +
      '<div class="cskill-tags" id="skillTags">' + skills.slice(0, 3).map(cardChip).join('') + '</div>' +
      '<button type="button" class="cskill-add" id="skillAddBtn" data-action="open-skills"><i class="fa-solid fa-plus"></i>Add skill</button>' +
      '</div>' +
      '<div class="idcard-foot"><span class="idcard-url">' + esc(siteUrl()) + '</span>' +
      '<span class="foot-right">' +
      '<button type="button" class="foot-icon" id="cardMuteBtn" data-action="card-video-mute" title="Unmute video" hidden><i class="fa-solid fa-volume-xmark"></i></button>' +
      '<button type="button" class="foot-icon" data-action="card-video-edit" title="Intro video — upload a clip"><i class="fa-solid fa-video"></i><span class="foot-icon-label" id="cardVideoLabel"></span></button>' +
      '<button type="button" class="flip-btn" data-action="flip-card"><i class="fa-solid fa-rotate"></i><span>More on the back</span></button>' +
      '</span></div>' +
      // skill picker — a temporary overlay over the card front
      '<div class="cskill-overlay" id="skillOverlay" hidden>' +
      '<div class="cskill-oh"><span>Add skills <b id="skillCount">(0/3)</b></span>' +
      '<button type="button" class="cskill-close" data-action="close-skills" aria-label="Done"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<div class="cskill-inrow"><input id="skillInput" placeholder="Type a skill…" autocomplete="off">' +
      '<button type="button" class="cskill-addbtn" data-action="add-typed-skill">Add</button></div>' +
      // the card's current skills mirrored inside the picker, so an added
      // skill is visible immediately without closing the overlay
      '<div class="cskill-mine" id="skillMine" hidden></div>' +
      '<div class="cskill-pool" id="skillPool"></div>' +
      '</div>' +
      // intro video picker — an inline overlay on the card (like the skill
      // picker), no popup windows
      '<div class="cskill-overlay video-overlay" id="videoOverlay" hidden>' +
      '<div class="cskill-oh"><span>Intro video</span>' +
      '<button type="button" class="cskill-close" data-action="close-video" aria-label="Done"><i class="fa-solid fa-xmark"></i></button></div>' +
      '<p class="video-ov-hint">Upload a short clip — it loops as your card’s backdrop.</p>' +
      '<div class="vid-panel" id="ytCard"></div>' +
      '</div>' +
      '</div>' + // close .idfront

      // ---------------- back
      '<div class="idface idback">' +
      '<div class="idband"></div>' +
      '<textarea class="cinput cbio" name="bio" maxlength="260" placeholder="Short bio — who you are, what excites you">' + esc(u.bio || '') + '</textarea>' +
      '<div class="idlinks">' +
      '<label class="cfield cfield-handle"><i class="fa-brands fa-github"></i><span class="handle-wrap"><span class="handle-prefix">github.com/</span><input class="cinput" name="linkGithub" autocomplete="off" maxlength="120" placeholder="username" value="' + esc(linkHandle('linkGithub', lg)) + '"></span><span class="link-status" id="ls_linkGithub" data-status=""></span></label>' +
      '<label class="cfield"><i class="fa-solid fa-globe"></i><input class="cinput" name="linkWebsite" autocomplete="off" maxlength="200" placeholder="yourwebsite.com" value="' + esc(lw) + '"><span class="link-status" id="ls_linkWebsite" data-status=""></span></label>' +
      '<label class="cfield cfield-handle"><i class="fa-brands fa-linkedin-in"></i><span class="handle-wrap"><span class="handle-prefix">linkedin.com/in/</span><input class="cinput" name="linkLinkedin" autocomplete="off" maxlength="120" placeholder="username" value="' + esc(linkHandle('linkLinkedin', ll)) + '"></span><span class="link-status" id="ls_linkLinkedin" data-status=""></span></label>' +
      '</div>' +
      '<div class="idcard-foot"><span class="idcard-url">' + esc(eventTagline()) + '</span>' +
      '<button type="button" class="flip-btn" data-action="flip-card"><i class="fa-solid fa-rotate"></i><span>Front</span></button></div>' +
      '</div>' +

      '</div></div>' +
      '<input type="hidden" name="image" value="' + esc(u.image || '') + '">' +
      '<input type="file" id="photoFile" accept="image/*" hidden>' +
      '</div>' + // .pf-left

      '<div class="pf-right">' +
      // intro video lives on the card (backdrop + footer buttons); only the
      // value travels with the form
      '<input type="hidden" name="video" value="' + esc(vid) + '">' +

      // live persona — Claude interprets the card as it fills in
      '<div class="persona" id="personaPanel"><p class="persona-text" id="personaText">' + esc(personaDefaultText(isNew)) + '</p></div>' +
      // wallet QR flyout — hidden; "Add to wallet" flips it into the persona
      // space above, auto-dismissing after 10s of inactivity (existing users only)
      (isNew ? '' :
        '<div class="wallet-flyout" id="walletFlyout" hidden>' +
        '<div class="wallet-block">' +
        '<button class="wallet-flyout-close" type="button" data-action="wallet-hide" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
        '<div class="wallet-block-qr" id="walletQrSlot"><div class="wallet-skel wallet-skel-qr"></div></div>' +
        '<div class="wallet-block-passes" id="walletPasses"><div class="wallet-skel wallet-skel-btn"></div><div class="wallet-skel wallet-skel-btn"></div></div>' +
        '</div>' +
        '</div>') +

      '<div class="form-status" id="profileStatus"></div>' +
      // always visible: the consent row activates once the card is complete,
      // and the button activates once consent is ticked. The tick itself is
      // never persisted anywhere — each registration asks fresh.
      '<div class="join-block" id="joinWrap">' +
      (isNew
        ? '<label class="consent"><input type="checkbox" id="consentBox" disabled> I agree that this information is stored by the organizers and that my profile is shown publicly to the workshop’s mentors and participants.</label>'
        : '') +
      (isNew ? '<p class="change-later-note">You can change all content later from your profile page.</p>' : '') +
      '<div class="form-actions">' +
      '<div class="fa-buttons" id="faButtons">' +
      (isNew ? '' : '<button class="btn btn-outline" type="button" data-action="wallet-show"><i class="fa-solid fa-wallet"></i>Add to wallet</button>') +
      '<button class="btn btn-gradient" type="submit"><span class="label">' + (isNew ? 'Let’s build something amazing' : 'Save changes') + '</span><span class="spin"></span></button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' + // .pf-right
      '</form>';
  }

  // ---- live persona (LLM via the backend `persona` action) ----

  function personaDefaultText(isNew) {
    if (!isNew) return 'This is how others will meet you — your persona refreshes as you edit the card.';
    var prefill = state.data && state.data.prefill;
    if (prefill && prefill.profile) {
      return 'Welcome back! Your card is filled in from last time — check it over, and watch your persona take shape here.';
    }
    return 'Every great team starts with a person. Fill in your card and a persona will take shape right here — it’s how mentors and other participants will first meet you.';
  }

  var personaTimer = null;
  var personaLastPayload = '';
  var personaDisabled = false; // backend has no API key configured

  function personaFields() {
    var form = $('#profileForm');
    if (!form) return null;
    var fd = new FormData(form);
    var first = String(fd.get('firstName') || '').trim();
    var last = String(fd.get('lastName') || '').trim();
    return {
      name: (first + ' ' + last).trim(),
      role: (function (r) { return r === 'mentor' || r === 'catalyst' ? r : 'participant'; })(form.getAttribute('data-role')),
      affiliation: String(fd.get('affiliation') || '').trim(),
      bio: String(fd.get('bio') || '').trim(),
      skills: getTagValues(),
    };
  }

  function schedulePersona() {
    if (personaDisabled) return;
    clearTimeout(personaTimer);
    personaTimer = setTimeout(refreshPersona, 1400);
  }

  // Last generated persona per project, kept locally so re-opening the card
  // shows it instantly — the LLM is only asked when the fields really changed.
  function personaCacheKey() { return 'ice.persona.' + A.getProject(); }
  function readPersonaCache() {
    try { return JSON.parse(localStorage.getItem(personaCacheKey()) || 'null'); } catch (e) { return null; }
  }
  function writePersonaCache(payload, text) {
    try { localStorage.setItem(personaCacheKey(), JSON.stringify({ p: payload, t: text })); } catch (e) { /* quota */ }
  }

  async function refreshPersona() {
    if (personaDisabled) return;
    var f = personaFields();
    if (!f) return;
    if (!f.name && !f.affiliation && !f.bio && !f.skills.length) return;
    var payload = JSON.stringify(f);
    if (payload === personaLastPayload) return;
    personaLastPayload = payload;
    // unchanged since the last generation → reuse it, no request, no delay
    var cached = readPersonaCache();
    if (cached && cached.p === payload && cached.t) {
      var elc = $('#personaText');
      if (elc) { elc.textContent = cached.t; elc.classList.remove('thinking'); }
      return;
    }
    var el = $('#personaText');
    if (el) el.classList.add('thinking');
    try {
      var r = await A.api('persona', f);
      if (r.disabled) { personaDisabled = true; return; }
      // only render if the form still matches what we asked about — a newer
      // keystroke has its own refresh queued
      var now = personaFields();
      if (!now || JSON.stringify(now) !== payload) return;
      var out = $('#personaText');
      if (out && r.text) out.textContent = r.text;
      if (r.text) writePersonaCache(payload, r.text);
    } catch (e) {
      /* persona is decorative — fail silently */
    } finally {
      var done = $('#personaText');
      if (done) done.classList.remove('thinking');
    }
  }

  // Public profile: show the same AI persona the person saw while building their
  // card, so visitors meet them the way they were introduced. Generated from the
  // public card fields via the same `persona` action (server-side cached by
  // content hash, so repeat views are cheap). Decorative — fails silently.
  // Per-member persona cache (localStorage) so a revisited profile shows its
  // blurb instantly, then quietly refreshes when the request returns.
  function profilePersonaKey(uid) { return 'ice.persona.u.' + A.getProject() + '.' + uid; }
  function showProfilePersona(text) {
    var box = $('#pvPersona'), txt = $('#pvPersonaText');
    if (!box || !txt) return; // view changed while the request was in flight
    txt.textContent = text;
    box.hidden = false;
  }

  function initProfilePersona(u) {
    var el = $('#pvPersona');
    if (!el || !u) return;
    // Serve any cached blurb immediately (even before we know if we can refresh).
    try {
      var stored = JSON.parse(localStorage.getItem(profilePersonaKey(u.id)) || 'null');
      if (stored && stored.t) showProfilePersona(stored.t);
    } catch (e) { /* ignore */ }
    // The persona endpoint is auth-gated (it bills an LLM), so only fetch it for
    // signed-in members — the people who actually browse each other's profiles.
    if (!signedIn()) return;
    var f = {
      name: u.name || '',
      role: hasRoleU(u, 'mentor') ? 'mentor' : hasRoleU(u, 'catalyst') ? 'catalyst' : 'participant',
      affiliation: u.affiliation || '',
      bio: u.bio || '',
      skills: u.skills || [],
    };
    if (!f.name && !f.affiliation && !f.bio && !f.skills.length) return;
    A.api('persona', f).then(function (r) {
      if (!r || r.disabled || !r.text) return;
      showProfilePersona(r.text); // update the UI with the fresh blurb
      try { localStorage.setItem(profilePersonaKey(u.id), JSON.stringify({ t: r.text })); } catch (e) { /* quota */ }
    }).catch(function () { /* persona is decorative */ });
  }

  var MAX_SKILLS = 3;

  function cardChip(s) {
    return '<span class="cskill" data-skill="' + esc(s) + '">' + esc(s) +
      '<i class="fa-solid fa-xmark" data-action="rm-tag" title="Remove"></i></span>';
  }

  function getTagValues() {
    return $all('#skillTags [data-skill]').map(function (c) { return c.getAttribute('data-skill'); });
  }

  // Sync the card skills row + overlay after any change.
  function refreshSkillsUI() {
    var values = getTagValues();
    var count = values.length;
    var addBtn = $('#skillAddBtn');
    if (addBtn) addBtn.style.display = count >= MAX_SKILLS ? 'none' : '';
    var cnt = $('#skillCount');
    if (cnt) cnt.textContent = '(' + count + '/' + MAX_SKILLS + ')';
    var mine = $('#skillMine');
    if (mine) { mine.innerHTML = values.map(cardChip).join(''); mine.hidden = count === 0; }
    renderSkillPool();
  }

  // The pick-from list inside the overlay (suggested skills + other users' skills).
  function renderSkillPool() {
    var box = $('#skillPool');
    if (!box) return;
    var existing = getTagValues().map(function (x) { return x.toLowerCase(); });
    if (getTagValues().length >= MAX_SKILLS) {
      box.innerHTML = '<div class="cskill-full">That’s ' + MAX_SKILLS + ' skills — the max. Remove one to swap.</div>';
      return;
    }
    var pool = {};
    opts('skill', C.SKILL_SUGGESTIONS).forEach(function (s) { pool[s] = 1; });
    ((state.data && state.data.users) || []).forEach(function (u) { (u.skills || []).forEach(function (s) { pool[s] = 1; }); });
    var items = Object.keys(pool).filter(function (s) { return existing.indexOf(s.toLowerCase()) === -1; });
    box.innerHTML = items.map(function (s) {
      return '<span class="cskill-pick" data-action="add-tag" data-skill="' + esc(s) + '"><i class="fa-solid fa-plus"></i>' + esc(s) + '</span>';
    }).join('');
  }

  // Title-case a typed skill on the way in so chips read consistently
  // ("web development" → "Web Development") — words already in all-caps
  // (acronyms like UX, AI, 3D) are left untouched.
  function capitalizeSkill(s) {
    return String(s || '').trim().replace(/\S+/g, function (w) {
      return w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  function addTag(s) {
    s = capitalizeSkill(s);
    if (!s) return;
    var values = getTagValues();
    if (values.length >= MAX_SKILLS) { toast('You can add up to ' + MAX_SKILLS + ' skills.', true); return; }
    if (values.map(function (x) { return x.toLowerCase(); }).indexOf(s.toLowerCase()) !== -1) return;
    var tags = $('#skillTags');
    if (tags) tags.insertAdjacentHTML('beforeend', cardChip(s));
    refreshSkillsUI();
    // flash the new chip in the picker's mirror row — instant feedback
    var mineChips = $all('#skillMine [data-skill]');
    if (mineChips.length) mineChips[mineChips.length - 1].classList.add('just-added');
    saveRegDraft();
    updateJoinState();
    schedulePersona();
    if (getTagValues().length >= MAX_SKILLS) closeSkills(); // the third pick finishes
  }

  function openSkills() {
    var ov = $('#skillOverlay');
    if (!ov) return;
    ov.hidden = false;
    refreshSkillsUI();
    var si = $('#skillInput');
    if (si) { si.value = ''; si.focus(); }
  }
  function closeSkills() {
    var ov = $('#skillOverlay');
    if (ov) ov.hidden = true;
  }

  // ---- profile draft autosave (localStorage) ----
  // Both forms are persisted so a refresh never drops typed values: the
  // fresh-registration form under regdraft, an existing profile's in-progress
  // edits under editdraft (kept separate so a half-typed edit can't shadow the
  // registration flow, and vice versa). Keyed per project — a draft started in a
  // test project must never surface in another project's form. Cleared on a
  // successful save.
  function regDraftKey() { return 'ice.regdraft.' + A.getProject(); }
  function editDraftKey() { return 'ice.editdraft.' + A.getProject(); }
  // The active form's key: registration vs editing an existing profile.
  function activeDraftKey() {
    var form = $('#profileForm');
    return (form && form.getAttribute('data-new') === '1') ? regDraftKey() : editDraftKey();
  }

  function collectRegDraft() {
    var form = $('#profileForm');
    if (!form) return null;
    var fd = new FormData(form);
    return {
      firstName: fd.get('firstName') || '', lastName: fd.get('lastName') || '',
      affiliation: fd.get('affiliation') || '',
      bio: fd.get('bio') || '', gender: fd.get('gender') || '',
      // links stored complete (bare handle → github.com/name) so re-bucketing by
      // hostname works on reload; the field re-derives the bare handle to display
      linkGithub: completeLink('linkGithub', fd.get('linkGithub')) || '',
      linkWebsite: fd.get('linkWebsite') || '',
      linkLinkedin: completeLink('linkLinkedin', fd.get('linkLinkedin')) || '', video: fd.get('video') || '',
      image: fd.get('image') || '', skills: getTagValues(),
    };
  }
  function saveRegDraft() {
    var d = collectRegDraft();
    if (!d) return;
    // Stamp the draft with the signed-in identity so it can only ever be
    // restored for the SAME person — a draft must not bleed into a different
    // account on a shared browser, nor resurrect an old card for someone who
    // was deleted and re-invited.
    d._email = (state.data && state.data.email) || '';
    try { localStorage.setItem(activeDraftKey(), JSON.stringify(d)); } catch (e) { /* quota */ }
  }
  function loadDraftAt_(key) {
    try {
      var d = JSON.parse(localStorage.getItem(key) || 'null');
      if (!d) return null;
      // Different identity than the one that saved it (account switch, or this
      // email was offboarded and re-invited) — the draft is stale, drop it.
      if ((d._email || '') !== ((state.data && state.data.email) || '')) {
        localStorage.removeItem(key);
        return null;
      }
      return d;
    } catch (e) { return null; }
  }
  function loadRegDraft() { return loadDraftAt_(regDraftKey()); }
  function loadEditDraft() { return loadDraftAt_(editDraftKey()); }
  function clearRegDraft() { localStorage.removeItem(regDraftKey()); }
  function clearEditDraft() { localStorage.removeItem(editDraftKey()); }

  // Draft → the user-shaped object profileForm() expects (name recombined,
  // links re-bucketed by hostname into the github/website/linkedin fields).
  function draftToUser(d) {
    if (!d) return null;
    return {
      name: ((d.firstName || '') + ' ' + (d.lastName || '')).trim(),
      affiliation: d.affiliation, bio: d.bio, gender: d.gender,
      image: d.image, video: d.video, skills: d.skills || [],
      links: [d.linkGithub, d.linkWebsite, d.linkLinkedin].filter(Boolean),
    };
  }

  // ---- access-code bypass of the invite-only gate ----
  // A person who enters the shared access code (C.ACCESS_CODE, e.g. "ice2026")
  // may register without a personal invite. The code is remembered per project
  // for the session and sent with `register`, where the backend re-checks it.
  function accessCodeKey() { return 'ice.access.' + A.getProject(); }
  function storedAccessCode() {
    try { return sessionStorage.getItem(accessCodeKey()) || ''; } catch (e) { return ''; }
  }
  function accessBypass() {
    var code = storedAccessCode(), want = String(C.ACCESS_CODE || '');
    return !!want && code.toLowerCase() === want.toLowerCase();
  }

  // A signed-in Google account that is NOT a member of this project — not
  // registered, not a global admin, not invited, and no access code. Such a
  // session is held at a switch-account gate (see route()/viewNotInvited) and
  // the backend refuses it every members-only action.
  function isLockedOut() {
    return signedIn() && state.loaded && !!state.data &&
      !me() && !state.data.isAdmin && !state.data.invite && !accessBypass();
  }

  // Full-app gate for a wrong/un-invited account: switch account or enter a code.
  function viewNotInvited() {
    var email = (state.data && state.data.email) || '';
    var isWorkAddr = /@designthinking\.lk$/i.test(email);
    return '<div class="empty access-gate">' +
      '<i class="fa-solid fa-user-lock"></i>' +
      '<h2 style="margin:8px 0 6px;font-size:22px">This account isn’t invited to ' + esc(eventName()) + '</h2>' +
      (email
        ? '<p style="color:var(--text-body);margin:0 0 4px">You’re signed in as <b>' + esc(email) + '</b>.</p>' +
          '<p style="color:var(--text-muted);margin:0">' +
          (isWorkAddr
            ? 'Sign in with the personal Google account your invitation was sent to.'
            : esc(eventName()) + ' is invite-only — use the Google account your invitation was sent to, or ask the organizers to invite you.') +
          '</p>'
        : '') +
      '<div class="form-actions" style="justify-content:center;margin-top:20px">' +
      '<button class="btn btn-gradient" data-action="sign-out"><i class="fa-solid fa-arrow-right-from-bracket"></i>Use a different account</button>' +
      '</div>' +
      '<div class="access-code"><input id="accessCodeInput" placeholder="Have an access code?" autocomplete="off" spellcheck="false">' +
      '<button class="btn btn-outline btn-sm" data-action="access-code-submit">Continue</button></div>' +
      '</div>';
  }

  function viewRegister() {
    if (!signedIn()) {
      return '<div class="empty" style="margin-top:40px"><i class="fa-solid fa-user-plus"></i>Sign in with Google first, then complete your profile.<br><br>' +
        '<button class="btn btn-gradient" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in with Google</button></div>';
    }
    if (me()) { location.hash = '#/me'; return ''; }
    if (state.data && !state.data.registrationOpen) {
      return '<div class="empty" style="margin-top:40px"><i class="fa-solid fa-door-closed"></i>Registration is closed. Contact the organizers if you believe this is a mistake.</div>';
    }
    // Invite-only: mirror the backend's register gate with an explanation
    // instead of a dead form. Only freshly loaded data decides — a cached
    // pre-invite bootstrap lacks the invite field.
    if (state.loaded && state.data && !state.data.invite && !state.data.isAdmin && !accessBypass()) {
      var isWorkAddr = /@designthinking\.lk$/i.test(state.data.email || '');
      return '<div class="empty" style="margin-top:40px"><i class="fa-regular fa-envelope"></i>' +
        esc(eventName()) + ' is invite-only.' +
        (state.data.email
          ? '<br>You are signed in as <b>' + esc(state.data.email) + '</b>. ' +
            (isWorkAddr
              ? 'This workshop account isn’t linked to a registration yet — sign in with the personal Google account your invitation was sent to, then this account will work too.'
              : 'If your invitation went to a different address, sign out and use that Google account — otherwise ask the organizers to invite you.')
          : '<br>Ask the organizers for an invitation, then sign in with the invited Google account.') +
        // Have an access code? Enter it to register without a personal invite.
        '<div class="access-code"><input id="accessCodeInput" placeholder="Have an access code?" autocomplete="off" spellcheck="false">' +
        '<button class="btn btn-gradient btn-sm" data-action="access-code-submit">Continue</button></div>' +
        '</div>';
    }
    if (!formReady()) return profileScaffold('', '', formLoading());
    setTimeout(afterProfileForm, 0);
    // A local draft wins; otherwise a returning person (known in the
    // cross-project directory) starts from their last profile. No heading —
    // the persona panel beside the card carries the narration.
    var prefill = state.data && state.data.prefill;
    var seed = draftToUser(loadRegDraft()) || (prefill && prefill.profile) || null;
    return profileScaffold('', '', profileForm(seed, true));
  }

  function viewMe() {
    if (!signedIn() || !me()) { location.hash = signedIn() ? '#/register' : '#/'; return ''; }
    if (!hasAccess(me())) {
      return '<div class="empty" style="margin-top:40px"><i class="fa-solid fa-user-lock"></i>' +
        'Your account has no assigned role, so the platform is read-only for now.<br>' +
        'Contact an organizer to restore access — your profile and data are safe.</div>';
    }
    if (!formReady()) return profileScaffold('', '', formLoading());
    setTimeout(afterProfileForm, 0);
    // Add-to-Wallet is a button next to "Save changes"; tapping it flips a QR
    // into the persona space (see showWalletFlyout) — no scrolling panel here.
    // In-progress edits (autosaved to editdraft) survive a refresh: overlay them
    // on the live profile so id/role/workEmail stay, but typed values return.
    var ed = loadEditDraft();
    var seed = ed ? Object.assign({}, me(), draftToUser(ed)) : me();
    return profileScaffold('', '', profileForm(seed, false));
  }

  function profileScaffold(title, sub, inner) {
    return '<div class="profile-edit">' +
      (title ? '<h1 style="font-size:30px">' + title + '</h1>' : '') +
      (sub ? '<p style="color:var(--text-body)">' + sub + '</p>' : '') + inner + '</div>';
  }

  // ---- link existence check + Join-button gating ----
  // Registration requires every field complete; the three web links are verified
  // server-side (js -> check_url) and must resolve before Join enables.
  var LINK_FIELDS = ['linkGithub', 'linkWebsite', 'linkLinkedin'];
  var linkStatus = {};   // field -> 'empty' | 'checking' | 'ok' | 'bad'
  var linkTimers = {};   // debounce handles
  var linkSeq = {};      // race guard: only the latest check per field wins

  function setLinkStatus(field, status) {
    linkStatus[field] = status;
    var el = document.getElementById('ls_' + field);
    if (el) {
      el.setAttribute('data-status', status);
      el.innerHTML =
        status === 'checking' ? '<i class="fa-solid fa-spinner fa-spin"></i>' :
        status === 'ok' ? '<i class="fa-solid fa-circle-check"></i>' :
        status === 'bad' ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '';
    }
    updateJoinState();
  }

  function checkLink(field, rawValue) {
    var v = normUrl(completeLink(field, rawValue));
    if (!v) { setLinkStatus(field, 'empty'); return; }
    setLinkStatus(field, 'checking');
    var seq = (linkSeq[field] = (linkSeq[field] || 0) + 1);
    A.api('check_url', { url: v }).then(function (r) {
      if (seq !== linkSeq[field]) return; // a newer keystroke superseded this
      setLinkStatus(field, r && r.exists ? 'ok' : 'bad');
    }).catch(function () {
      if (seq !== linkSeq[field]) return;
      setLinkStatus(field, 'bad');
    });
  }

  function wireLinkChecks(pform) {
    LINK_FIELDS.forEach(function (f) {
      var input = pform.querySelector('[name="' + f + '"]');
      if (!input) return;
      var isHandle = f === 'linkGithub' || f === 'linkLinkedin';
      var runCheck = function () {
        if (input.value.trim()) checkLink(f, input.value); else setLinkStatus(f, 'empty');
      };
      runCheck();
      input.addEventListener('input', function () {
        // a pasted full URL in a handle field collapses to just the username,
        // so the input always mirrors what shows after the fixed prefix
        if (isHandle) {
          var h = linkHandle(f, input.value);
          if (h !== input.value) {
            var atEnd = input.selectionStart === input.value.length;
            input.value = h;
            if (atEnd) { try { input.setSelectionRange(h.length, h.length); } catch (e) {} }
          }
        }
        setLinkStatus(f, input.value.trim() ? 'checking' : 'empty');
        clearTimeout(linkTimers[f]);
        linkTimers[f] = setTimeout(runCheck, 600);
      });
      input.addEventListener('blur', function () {
        // handle fields stay as the bare username; other fields (website)
        // materialise a bare host into a full URL on leave
        var next = isHandle ? linkHandle(f, input.value) : completeLink(f, input.value);
        if (next !== input.value.trim()) {
          input.value = next;
          runCheck();
          saveRegDraft();
        }
      });
    });
  }

  // Onboarding cue: a new user reported it wasn't obvious what to do, so every
  // field still needing a value gets a subtle animated glow until it's filled —
  // and while the back of the card has gaps, the "flip" button glows too, to
  // point people to the other side. Runs for both the new and edit forms; on a
  // complete profile nothing glows.
  function updateFieldHints() {
    var form = $('#profileForm');
    if (!form) return;
    var val = function (n) {
      var el = form.querySelector('[name="' + n + '"]');
      return el ? String(el.value || '').trim() : '';
    };
    var mark = function (el, need) { if (el) el.classList.toggle('needs-fill', !!need); };

    // text fields on the card (names, affiliation, bio, links). Catalysts aren't
    // asked for links, so those fields never glow for them.
    var hintCatalyst = form.getAttribute('data-role') === 'catalyst';
    ['firstName', 'lastName', 'affiliation', 'bio',
     'linkGithub', 'linkWebsite', 'linkLinkedin'].forEach(function (n) {
      if (hintCatalyst && (n === 'linkGithub' || n === 'linkWebsite' || n === 'linkLinkedin')) return;
      var el = form.querySelector('[name="' + n + '"]');
      if (el) mark(el, !el.value.trim());
    });
    // photo, skills — non-input targets. The intro video is OPTIONAL (the
    // default backdrop plays when none is set), so it is never marked as a gap.
    mark(form.querySelector('.photo-vp'), !(photoEd || val('image')));
    mark(form.querySelector('#skillAddBtn'), getTagValues().length === 0);
    // front "flip" button glows while the back still has gaps. Catalysts (guests)
    // aren't asked for links, so only the bio counts as a back-side gap for them.
    var isCatalystCard = form.getAttribute('data-role') === 'catalyst';
    var backGap = isCatalystCard
      ? !val('bio')
      : (!val('bio') || !val('linkGithub') || !val('linkWebsite') || !val('linkLinkedin'));
    mark(form.querySelector('.idfront [data-action="flip-card"]'), backGap);
  }

  // A stable fingerprint of the Save-tracked card content. Excludes the intro
  // video on purpose: uploading/removing a clip persists immediately (like the
  // photo does not — but the video does), so it must not drive the Save button.
  var profileBaselineSig = '';
  function profileSignature() {
    var form = $('#profileForm');
    if (!form) return '';
    var fd = new FormData(form);
    var g = function (n) { return String(fd.get(n) || '').trim(); };
    return JSON.stringify({
      name: (g('firstName') + ' ' + g('lastName')).trim(),
      affiliation: g('affiliation'), bio: g('bio'), gender: g('gender'),
      lg: g('linkGithub'), lw: g('linkWebsite'), ll: g('linkLinkedin'),
      skills: getTagValues(), image: g('image'), photoEdited: !!photoEd,
    });
  }
  // Edit form: enable "Save changes" only when the tracked content actually
  // differs from what was loaded — an unchanged card shows a disabled button so
  // it never looks like there's something to save.
  function updateEditSaveState() {
    var form = $('#profileForm');
    if (!form || form.getAttribute('data-new') === '1') return; // new form uses the Join gate
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    var dirty = profileSignature() !== profileBaselineSig;
    btn.disabled = !dirty;
    btn.classList.toggle('btn-disabled', !dirty);
  }

  // Enable Join only when the whole card is complete (new registrations only).
  function updateJoinState() {
    updateFieldHints();
    updateEditSaveState();
    var form = $('#profileForm');
    if (!form || form.getAttribute('data-new') !== '1') return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    var fd = new FormData(form);
    var has = function (n) { return String(fd.get(n) || '').trim().length > 0; };
    var isCatalystCard = form.getAttribute('data-role') === 'catalyst';
    var photoOk = !!photoEd || has('image');
    var textOk = has('firstName') && has('lastName') && has('affiliation') && has('bio');
    var skillsOk = getTagValues().length > 0;
    // Intro video is optional — a member can join without one (the default
    // card backdrop plays in its place), so it's not part of the gate. Links are
    // required for builders; catalysts (guests) may leave them blank, but a link
    // they DO type must still resolve.
    var linksOk = LINK_FIELDS.every(function (f) {
      var s = linkStatus[f];
      return s === 'ok' || (isCatalystCard && (s === 'empty' || !s));
    });
    var complete = photoOk && textOk && skillsOk && linksOk;
    // staged activation: complete card → consent unlocks; consent ticked →
    // button unlocks. Consent is never persisted, and it un-ticks if the
    // card drops back to incomplete.
    var consent = $('#consentBox');
    if (consent) {
      consent.disabled = !complete;
      if (!complete && consent.checked) consent.checked = false;
    }
    var ready = complete && (!consent || consent.checked);
    btn.disabled = !ready;
    btn.classList.toggle('btn-disabled', !ready);
  }

  // ---- name inputs size to their exact rendered text, so first + last read as
  // one name with a single natural space between them ----
  var nameMeasureEl = null;
  function measureNameWidth(input) {
    if (!nameMeasureEl) {
      nameMeasureEl = document.createElement('span');
      nameMeasureEl.style.cssText = 'position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:pre;';
      document.body.appendChild(nameMeasureEl);
    }
    var cs = getComputedStyle(input);
    nameMeasureEl.style.fontFamily = cs.fontFamily;
    nameMeasureEl.style.fontSize = cs.fontSize;
    nameMeasureEl.style.fontWeight = cs.fontWeight;
    nameMeasureEl.style.fontStyle = cs.fontStyle;
    nameMeasureEl.style.letterSpacing = cs.letterSpacing;
    nameMeasureEl.textContent = input.value || input.placeholder || '';
    return nameMeasureEl.getBoundingClientRect().width;
  }
  function sizeName(input) {
    input.style.fontSize = ''; // measure at full size first
    // The input is border-box: its padding + border change between the rest
    // and focused states, so they must be added to the measured text width —
    // otherwise the last letter crops whenever the field is focused.
    var cs = getComputedStyle(input);
    var chrome = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
      (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0) +
      // caret room on focus — generous so the field never scrolls (and crops the
      // start of the name) while you're mid-word; the measure span can also run a
      // hair narrow than the input's own text rendering.
      10;
    // Each name may grow to half the row (minus the leading icon slot) so
    // first + last always fit side by side; past that the text shrinks.
    var row = input.closest('.cname-row');
    var cap = row ? Math.max(70, Math.floor((row.clientWidth - 34) / 2) - 4) : 0;
    var w = measureNameWidth(input) + chrome;
    if (cap && w > cap) {
      var base = parseFloat(cs.fontSize) || 18;
      var size = Math.max(11, base * (cap - chrome) / (w - chrome));
      input.style.fontSize = size.toFixed(1) + 'px';
      w = Math.min(cap, measureNameWidth(input) + chrome);
    }
    input.style.width = Math.ceil(w) + 'px';
  }

  // ---- proposed workshop email (firstname@designthinking.lk), checked live ----
  // Mirrors the backend's assignment: firstname@ first, and if that's taken it
  // auto-advances to firstname.lastname@ (then numbered) — showing the address the
  // account will actually get. New registrations only.
  var WORKSPACE_DOMAIN = 'designthinking.lk';
  var emailSeq = 0;
  var emailTimer = null;

  function emailHandle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  function setProposedEmailUI(status, email) {
    var box = $('#proposedEmail'), addr = $('#cemailAddr'), st = $('#cemailStatus');
    if (!box) return;
    box.hidden = false;
    if (addr) addr.textContent = email;
    if (st) {
      st.setAttribute('data-status', status);
      st.innerHTML =
        status === 'checking' ? '<i class="fa-solid fa-spinner fa-spin"></i>' :
        status === 'ok' ? '<i class="fa-solid fa-circle-check" title="Available"></i>' :
        status === 'bad' ? '<i class="fa-solid fa-triangle-exclamation" title="Could not verify"></i>' : '';
    }
  }

  function updateProposedEmail() {
    var form = $('#profileForm');
    if (!form || form.getAttribute('data-new') !== '1') return;
    var box = $('#proposedEmail');
    if (!box) return;
    // Returning person: they keep the account they already have — show it
    // instead of proposing (and checking) a fresh address.
    var prefill = state.data && state.data.prefill;
    if (prefill && prefill.workEmail) {
      setProposedEmailUI('ok', prefill.workEmail);
      var st0 = $('#cemailStatus');
      if (st0) st0.innerHTML = '<i class="fa-solid fa-circle-check" title="Your existing workshop account — you keep it"></i>';
      return;
    }
    // No workshop accounts are minted in this project (test projects).
    if (proj().provisionAccounts === false) { box.hidden = true; return; }
    var fd = new FormData(form);
    var f = emailHandle(fd.get('firstName'));
    var l = emailHandle(fd.get('lastName'));
    if (!f) { box.hidden = true; return; }
    var candidates = [f];
    if (l) { candidates.push(f + '.' + l); for (var n = 2; n <= 9; n++) candidates.push(f + '.' + l + n); }
    else { for (var m = 2; m <= 9; m++) candidates.push(f + m); }
    var seq = ++emailSeq;
    setProposedEmailUI('checking', candidates[0] + '@' + WORKSPACE_DOMAIN);
    (function tryNext(i) {
      if (i >= candidates.length) return; // give up quietly
      var email = candidates[i] + '@' + WORKSPACE_DOMAIN;
      setProposedEmailUI('checking', email);
      A.api('check_email', { email: email }).then(function (r) {
        if (seq !== emailSeq) return; // superseded by a newer keystroke
        if (r && r.available) setProposedEmailUI('ok', email);
        else tryNext(i + 1); // taken → auto-advance to firstname.lastname, etc.
      }).catch(function () {
        if (seq !== emailSeq) return;
        setProposedEmailUI('bad', email);
      });
    })(0);
  }

  function afterProfileForm() {
    photoEd = null; // fresh form; only set when the user picks a new photo
    linkStatus = {}; linkTimers = {}; linkSeq = {}; emailSeq = 0;
    refreshSkillsUI();
    var pform = $('#profileForm');
    if (pform) {
      wireLinkChecks(pform); // verify links + show ✓/⚠ (both new and edit forms)
      // Name inputs size to their content so first + last read as one name.
      var nameInputs = ['firstName', 'lastName'].map(function (nm) {
        return pform.querySelector('[name="' + nm + '"]');
      }).filter(Boolean);
      nameInputs.forEach(function (inp) {
        sizeName(inp);
        inp.addEventListener('input', function () { sizeName(inp); });
        // padding/border differ between rest and focus — re-measure on both
        inp.addEventListener('focus', function () { sizeName(inp); });
        inp.addEventListener('blur', function () { sizeName(inp); });
      });
      // Re-measure once the display font loads (initial measure may hit the fallback).
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { nameInputs.forEach(sizeName); });
      }
      // Live persona: any edit (both new and edit forms) re-interprets the card.
      personaLastPayload = '';
      pform.addEventListener('input', schedulePersona);
      pform.addEventListener('change', schedulePersona);
      // Keep the "needs filling" glow in sync as text fields change (updateJoinState
      // covers photo/skills/video/links, but bails early on the edit form).
      pform.addEventListener('input', updateFieldHints);
      pform.addEventListener('change', updateFieldHints);
      refreshPersona(); // initial (edit form / restored draft / prefill)
      // Autosave BOTH forms (new + edit) so a refresh never drops typed values.
      pform.addEventListener('input', saveRegDraft);
      pform.addEventListener('change', saveRegDraft);
      var isNew = pform.getAttribute('data-new') === '1';
      if (!isNew) {
        // Edit form: snapshot the loaded content, then gate "Save changes" on it
        // changing. Skill/photo/video paths all run through updateJoinState too.
        profileBaselineSig = profileSignature();
        pform.addEventListener('input', updateEditSaveState);
        pform.addEventListener('change', updateEditSaveState);
        updateEditSaveState(); // start disabled — nothing changed yet
      }
      if (isNew) {
        // Re-evaluate the Join gate as the fresh-registration form changes.
        var onEdit = function () { updateJoinState(); };
        pform.addEventListener('input', onEdit);
        pform.addEventListener('change', onEdit);
        // Debounced proposed-email lookup as the first/last name change.
        var nameFields = ['firstName', 'lastName'];
        nameFields.forEach(function (nm) {
          var inp = pform.querySelector('[name="' + nm + '"]');
          if (!inp) return;
          inp.addEventListener('input', function () {
            clearTimeout(emailTimer);
            emailTimer = setTimeout(updateProposedEmail, 450);
          });
        });
        updateProposedEmail(); // initial (e.g. restored draft)
      }
    }
    renderCardVideo(); // card backdrop from the stored/drafted video
    var file = $('#photoFile');
    if (file) file.addEventListener('change', function () {
      if (file.files && file.files[0]) photoLoad(file.files[0]);
    });
    // Card fields print onto a physical card: keep them single-paragraph so
    // the unfocused (printed) view never needs to scroll.
    var bio = $('#profileForm [name="bio"]');
    if (bio) {
      bio.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
      bio.addEventListener('input', function () {
        var flat = bio.value.replace(/\s*\n+\s*/g, ' ');
        if (flat !== bio.value) bio.value = flat;
      });
    }
    updateJoinState(); // initial state (disabled until everything is complete)
  }

  // ----------------------------------------------------------------- admin

  // ---- Projects & Tools (logged-in only; placeholder content for now) ----

  function signInGate(what) {
    return '<div class="empty" style="margin-top:40px"><i class="fa-solid fa-lock"></i>' +
      'Sign in to view ' + esc(what) + '.<br><br>' +
      '<button class="btn btn-gradient" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in with Google</button></div>';
  }

  // Placeholder showcase until teams publish real projects — 6 cards at the
  // ID-card aspect ratio, each with its own backdrop.
  var DEMO_PROJECTS = [
    { t: 'Smart Mobility', d: 'Rethinking how the city moves — accessible transit for everyone.' },
    { t: 'CareConnect', d: 'Bridging patients and caregivers with human-centred health tools.' },
    { t: 'AgriSense', d: 'Data-driven decisions for smallholder farmers.' },
    { t: 'EduPlay', d: 'Learning through play — creative classrooms beyond the textbook.' },
    { t: 'Circular Living', d: 'Designing waste out of everyday life, one household at a time.' },
    { t: 'FinAccess', d: 'Everyday finance for the unbanked and underserved.' },
  ];

  // ---- Projects: six cards backed by the team_projects tab. A card's owning
  //      team is the team at the same sorted index (homeTeams()[slot]); only
  //      that team's members (or an admin) may edit its title/description/colour.
  var projSel = null;      // open slot (null = grid)
  var projEdit = false;    // inline edit mode within the open panel
  var projEditColor = '';  // pending colour while editing
  var projStack = [];      // slots front→back while a project is open (for flipping)
  var projEditTab = 'details';         // active edit tab: 'details' | 'about' | 'video'
  var projViewTab = 'details';         // active VIEW tab: 'details' | 'demo'
  var projWebStatus = 'ok';            // website reachability: 'empty'|'checking'|'ok'|'bad'
  var projEditDraft = { title: '', description: '', fullDescription: '', website: '' }; // unsaved edits
  var projEditBaseline = null; // loaded values — Save enables only when the draft differs

  function teamProjectsData() {
    var tp = state.data && state.data.teamProjects;
    if (tp && tp.length) return tp.slice().sort(function (a, b) { return a.slot - b.slot; });
    return DEMO_PROJECTS.map(function (p, i) { return { slot: i, title: p.t, description: p.d, color: 'pc-' + (i + 1) }; });
  }
  function projectBySlot(slot) {
    var found = null;
    teamProjectsData().forEach(function (p) { if (p.slot === slot) found = p; });
    return found;
  }
  function projectTeam(slot) { return homeTeams()[slot]; }
  function projectMembers(slot) {
    var team = projectTeam(slot);
    if (!team || team.demo) return [];
    // admin-only members never surface on a project card
    return (team.members || []).map(userById).filter(Boolean).filter(isCommunityMember);
  }
  function canEditProject(slot) {
    if (!me()) return false;
    if (state.data && state.data.isAdmin) return true;
    var team = projectTeam(slot);
    return !!(team && !team.demo && (team.members || []).indexOf(me().id) !== -1);
  }
  function projColorClass(p, slot) { return /^pc-[1-6]$/.test(p && p.color) ? p.color : ('pc-' + (slot + 1)); }
  function teamLabel(slot) { var t = projectTeam(slot); return t ? t.name : 'Team ' + String.fromCharCode(65 + slot); }

  function projectCardHtml(p) {
    var slot = p.slot;
    var url = projCardUrl(p);
    var mine = slot === myTeamSlot();
    return '<article class="project-card ' + projColorClass(p, slot) + (mine ? ' is-mine' : '') + '" data-action="proj-open" data-slot="' + slot + '" tabindex="0">' +
      '<span class="pc-team">' + esc(teamLabel(slot)) + '</span>' +
      (url ? '<div class="pc-qr" data-url="' + esc(url) + '" title="Scan for the project site"></div>' : '') +
      '<div class="pc-text"><h3>' + esc(p.title) + '</h3><p>' + esc(p.description) + '</p></div>' +
      '</article>';
  }

  function viewProjects(slot) {
    projSel = null; projEdit = false; projEditColor = ''; // always render the grid state
    // Projects are community-only. A signed-out visitor (e.g. opening a shared
    // project link) sees a teaser for that project + an invite prompt instead.
    if (!signedIn()) {
      var pp = (slot !== undefined && slot !== '') ? projectBySlot(Number(slot)) : null;
      return '<div class="pub-gate">' +
        (pp && pp.title
          ? '<div class="pub-gate-card"><span class="pub-gate-kicker">' + esc(eventName()) + ' &middot; Project</span>' +
              '<h1>' + esc(pp.title) + '</h1>' + (pp.description ? '<p>' + esc(pp.description) + '</p>' : '') + '</div>'
          : '') +
        '<div class="pub-gate-cta"><i class="fa-solid fa-lock"></i>' +
          '<h2>Projects are for the ' + esc(eventName()) + ' community</h2>' +
          '<p>Sign in to explore every team’s project and demo — or request an invite to join the community.</p>' +
          '<button class="btn btn-gradient" data-action="sign-in"><i class="fa-brands fa-google"></i>Sign in</button>' +
        '</div></div>';
    }
    return '<div class="projects-wrap"><div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div><div class="projects-grid" id="projectsGrid">' +
      teamProjectsData().map(projectCardHtml).join('') +
      '<div class="proj-members-strip" id="projMembersStrip" hidden></div>' +
      '<div class="proj-detail" id="projDetail" hidden></div>' +
      '</div></div>';
  }

  // People circles + aggregated skills, shown below the stacked card.
  function projMembersStripHtml(slot) {
    var members = projectMembers(slot);
    var parts = members.filter(function (u) { return teamSlot(u) === 'participant'; });
    var ments = members.filter(function (u) { return teamSlot(u) === 'mentor'; });
    function circle(u, kind) {
      if (u) return '<a class="pms-avatar" href="#/profile/' + esc(u.id) + '" data-action="proj-nav" title="' + esc(u.name) + '">' + avatar(u, 'avatar-sm') + '</a>';
      return '<span class="pms-slot pms-' + kind + '" title="' + (kind === 'mentor' ? 'Mentor' : 'Member') + ' slot — open">' + (kind === 'mentor' ? '<i class="fa-solid fa-user-tie"></i>' : '') + '</span>';
    }
    var chips = '';
    for (var i = 0; i < TEAM_CAP.participant; i++) chips += circle(parts[i], 'participant');
    chips += '<span class="pms-sep" aria-hidden="true"></span>';
    for (var j = 0; j < TEAM_CAP.mentor; j++) chips += circle(ments[j], 'mentor');
    // aggregate every member's skills, with a per-skill count
    var counts = {};
    members.forEach(function (u) {
      (u.skills || []).forEach(function (s) { s = String(s || '').trim(); if (s) counts[s] = (counts[s] || 0) + 1; });
    });
    var skills = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    var skillsHtml = skills.length
      ? skills.map(function (s) { return '<span class="pms-skill' + (isMySkill(s) ? ' is-mine' : '') + '">' + esc(s) + '<b>' + counts[s] + '</b></span>'; }).join('')
      : '<span class="pms-none">No skills listed yet.</span>';
    return '<div class="pms-head">People</div>' +
      '<div class="pms-chips">' + chips + '</div>' +
      '<div class="pms-head pms-head-2">Skills</div>' +
      '<div class="pms-skills">' + skillsHtml + '</div>';
  }
  function renderMembersStrip() {
    var s = $('#projMembersStrip');
    if (s && projSel != null) s.innerHTML = projMembersStripHtml(projSel);
  }

  // A Drive video plays from more than one host form; offer both as <source>s.
  // Same streaming fix as videoSourcesHtml — Drive videos must come from the
  // usercontent download endpoint, not the lh3 poster-frame URL.
  function projVideoSourcesHtml(url) { return videoSourcesHtml(url); }
  // The pitch clip no longer plays as an ambient card backdrop — it lives in the
  // view card's Demo tab — so nothing drives the has-video styling any more.
  function projShowVideo() { return false; }
  function truthyStr(v) { return v === '1' || v === 1 || v === true || v === 'true'; }
  function prettyUrl(u) { return String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, ''); }
  function looksLikeUrl(u) { return /^https?:\/\/\S+\.\S+/i.test(u) || /^[\w-]+(\.[\w-]+)+/.test(u); }
  // A valid, reachable project website → the card shows a live-generated QR.
  function projCardUrl(p) { return (p && p.website && truthyStr(p.websiteOk)) ? p.website : ''; }
  // Small client-side QR (qrcode lib); the container is sized by CSS.
  function renderMiniQr_(el, text) {
    if (!el) return;
    try {
      var qr = qrcode(0, 'M'); qr.addData(text); qr.make();
      el.innerHTML = qr.createImgTag(3, 1);
      var img = el.querySelector('img');
      if (img) { img.style.width = '100%'; img.style.height = 'auto'; img.style.display = 'block'; img.style.imageRendering = 'pixelated'; img.alt = 'Project QR'; }
    } catch (e) { el.innerHTML = ''; }
  }
  // Render the QR onto every grid card that carries a valid website.
  function renderProjectCardQRs() {
    var grid = $('#projectsGrid'); if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.pc-qr[data-url]'), function (el) {
      renderMiniQr_(el, el.getAttribute('data-url'));
    });
  }

  // Detail region (right of the stack): a looping muted video background (when
  // uploaded) with title + description + inline edit, actions pinned in a footer.
  function projectDetailHtml(slot) {
    var p = projectBySlot(slot);
    if (!p) return '';
    var canEdit = canEditProject(slot);
    var editing = projEdit && canEdit;
    var inner, footer;
    if (editing) {
      var color = projEditColor || projColorClass(p, slot);
      var tab = projEditTab || 'details';
      var tabs =
        '<div class="proj-tabs">' +
        '<button type="button" class="proj-tab' + (tab === 'details' ? ' on' : '') + '" data-action="proj-edit-tab" data-tab="details">Details</button>' +
        '<button type="button" class="proj-tab' + (tab === 'about' ? ' on' : '') + '" data-action="proj-edit-tab" data-tab="about">About</button>' +
        '<button type="button" class="proj-tab' + (tab === 'video' ? ' on' : '') + '" data-action="proj-edit-tab" data-tab="video"><i class="fa-solid fa-video"></i>Video</button>' +
        '</div>';
      var tabBody;
      if (tab === 'video') {
        // Buttons/progress live in the footer (below); the body just states the
        // rules (no clip) or confirms what's playing (clip present).
        tabBody =
          '<p class="proj-vid-lead">Your team’s pitch clip — plays in the card’s Demo tab.</p>' +
          (p.video
            ? '<div class="vid-now"><i class="fa-solid fa-circle-play"></i><div class="vid-now-txt">' +
                '<span class="vid-now-label">Added to your project</span>' +
                '<span class="vid-now-name">Your pitch clip</span></div></div>'
            : videoReqHtml());
      } else if (tab === 'about') {
        tabBody =
          '<p class="proj-vid-lead">A longer write-up — shown under the short description when the card is open.</p>' +
          '<textarea class="proj-full-in" id="projFullIn" maxlength="600" rows="9" placeholder="Tell the story — the problem, your approach, what you built…">' + esc(projEditDraft.fullDescription) + '</textarea>';
      } else {
        tabBody =
          '<label class="proj-lbl">Project title <span class="proj-lbl-hint">— one line</span></label>' +
          '<input class="proj-title-in" id="projTitleIn" maxlength="40" value="' + esc(projEditDraft.title) + '" placeholder="Project title">' +
          '<label class="proj-lbl">Short description <span class="proj-lbl-hint">— shown on the card, two lines</span></label>' +
          '<textarea class="proj-desc-in" id="projDescIn" maxlength="105" rows="2" placeholder="One-line pitch">' + esc(projEditDraft.description) + '</textarea>' +
          '<label class="proj-lbl">Project website</label>' +
          '<div class="proj-web-row">' +
            '<input class="proj-web-in" id="projWebIn" type="url" maxlength="300" value="' + esc(projEditDraft.website) + '" placeholder="https://your-project.com">' +
            '<div class="proj-qr-preview" id="projQrPreview" title="Live QR preview"></div>' +
          '</div>';
      }
      inner = tabs + '<div class="proj-tab-body">' + tabBody + '</div>';
      var footActions =
        '<div class="proj-foot-actions">' +
          '<button class="btn btn-ghost" type="button" data-action="proj-cancel">Cancel</button>' +
          '<button class="btn btn-gradient" type="button" data-action="proj-save" data-slot="' + slot + '"><span class="label">Save changes</span><span class="spin"></span></button>' +
        '</div>';
      if (tab === 'video') {
        // The video tab reclaims the footer for its own controls: status + a
        // progress bar (during a transfer) over a row of upload/remove + save.
        footer =
          '<div class="proj-vid-foot">' +
            '<div class="vid-status" id="projVideoStatus"></div>' +
            '<div class="proj-vid-footrow" id="projVideoFootRow">' +
              '<div class="vid-actions" id="projVideoActions">' +
                '<button class="btn btn-outline btn-sm" type="button" data-action="proj-upload-video" data-slot="' + slot + '"><i class="fa-solid fa-upload"></i>' + (p.video ? 'Replace video' : 'Upload video') + '</button>' +
                (p.video ? '<button class="btn btn-ghost btn-sm proj-vid-remove" type="button" data-action="proj-remove-video" data-slot="' + slot + '"><i class="fa-regular fa-trash-can"></i>Remove</button>' : '') +
              '</div>' +
              footActions +
            '</div>' +
            // during a transfer the whole button row hides and this bar takes its place
            '<div class="vid-progress" id="projVideoProgress" hidden><div class="vid-progress-bar" id="projVideoBar"></div></div>' +
          '</div>';
      } else {
        // Colour swatches belong to Details only.
        var swatches = (tab === 'details')
          ? '<div class="proj-colors">' + [1, 2, 3, 4, 5, 6].map(function (n) {
              var c = 'pc-' + n;
              return '<button type="button" class="proj-swatch ' + c + (c === color ? ' on' : '') + '" data-action="proj-color" data-color="' + c + '" data-slot="' + slot + '" aria-label="Colour ' + n + '"></button>';
            }).join('') + '</div>'
          : '';
        footer = swatches + footActions;
      }
    } else {
      // ---- view mode: Details / Demo tabs (Demo only when a clip exists) ----
      var hasVid = !!p.video;
      var vtab = (hasVid && projViewTab === 'demo') ? 'demo' : 'details';
      var vtabs = hasVid
        ? '<div class="proj-tabs proj-view-tabs">' +
            '<button type="button" class="proj-tab' + (vtab === 'details' ? ' on' : '') + '" data-action="proj-view-tab" data-tab="details">Details</button>' +
            '<button type="button" class="proj-tab' + (vtab === 'demo' ? ' on' : '') + '" data-action="proj-view-tab" data-tab="demo"><i class="fa-solid fa-clapperboard"></i>Demo</button>' +
          '</div>'
        : '';
      if (vtab === 'demo') {
        // Manual playback: native controls (play + scrubber + fullscreen) plus an
        // explicit full-screen button. No autoplay — the member presses play.
        inner = vtabs +
          '<div class="proj-demo">' +
            '<video class="proj-demo-video" id="projDemoVideo" controls playsinline preload="metadata">' + projVideoSourcesHtml(p.video) + '</video>' +
            '<button class="proj-demo-fs" type="button" data-action="proj-demo-fullscreen" title="Full screen"><i class="fa-solid fa-expand"></i></button>' +
          '</div>';
        footer = '';
      } else {
        var web = '';
        if (p.website) {
          var broken = !truthyStr(p.websiteOk);
          web = '<a class="proj-d-web' + (broken ? ' broken' : '') + '" href="' + esc(p.website) + '" target="_blank" rel="noopener">' +
            (broken ? '<i class="fa-solid fa-triangle-exclamation" title="This link looked broken when last saved"></i>' : '<i class="fa-solid fa-globe"></i>') +
            '<span>' + esc(prettyUrl(p.website)) + '</span></a>';
        }
        inner = vtabs +
          '<h2 class="proj-d-title">' + esc(p.title) + '</h2>' +
          '<p class="proj-d-desc">' + esc(p.description) + '</p>' +
          (p.fullDescription ? '<p class="proj-d-full">' + esc(p.fullDescription).replace(/\n/g, '<br>') + '</p>' : '');
        // website on the left of the footer, edit as an icon on the right. On your
        // OWN project a shareable "business card" wallet button sits between them.
        var mineProj = signedIn() && slot === myTeamSlot();
        var walletBtn = mineProj
          ? '<button class="btn btn-outline btn-sm proj-wallet-btn" type="button" data-action="pcard-show" data-slot="' + slot + '"><i class="fa-solid fa-wallet"></i>Add to wallet</button>'
          : '';
        var shareBtn = '<button class="btn btn-outline btn-sm proj-share-btn" type="button" data-action="card-share" data-kind="p" data-id="' + slot + '"><i class="fa-solid fa-share-nodes"></i>Share</button>';
        footer = web + shareBtn + walletBtn + (canEdit
          ? '<button class="proj-edit-btn" type="button" data-action="proj-edit-inline" data-slot="' + slot + '" title="Edit project" aria-label="Edit project"><i class="fa-solid fa-pen"></i></button>'
          : '');
      }
    }
    var videoBg = ''; // the clip now lives in the Demo tab, not as an ambient backdrop
    var footerCls = 'proj-d-footer' + (editing ? '' : ' proj-d-footer-view');
    return videoBg +
      '<button class="proj-close" type="button" data-action="proj-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="proj-d-inner">' + inner + '</div>' +
      (footer ? '<div class="' + footerCls + '">' + footer + '</div>' : '');
  }

  // ---- Project business-card wallet: flip the open detail into a QR + wallet
  //      buttons, hiding its text. The QR encodes the shareable #/pcard handoff.
  function showProjectCardWallet(slot) {
    var detail = $('#projDetail');
    if (!detail || slot !== myTeamSlot()) return;
    detail.classList.add('pcard-open');
    var ov = detail.querySelector('.proj-wallet-overlay');
    if (!ov) { ov = document.createElement('div'); ov.className = 'proj-wallet-overlay'; detail.appendChild(ov); }
    ov.innerHTML =
      '<button class="proj-wallet-back" type="button" data-action="pcard-hide" aria-label="Back"><i class="fa-solid fa-arrow-left"></i></button>' +
      '<div class="pwo-head"><i class="fa-solid fa-id-card"></i> Share your project card</div>' +
      '<div class="pwo-body"><div class="wallet-loading"><span class="spin"></span> Preparing…</div></div>';
    var body = ov.querySelector('.pwo-body');
    A.api('project_wallet_link', {}).then(function (r) {
      if (!r || !r.url) throw new Error((r && r.message) || 'Could not prepare the card.');
      return Promise.all([
        r.url,
        A.api('project_pass', {}).then(function (x) { return x && x.url; }, function () { return null; }),
        A.api('apple_project_pass', {}).then(function (x) { return x && x.url; }, function () { return null; })
      ]);
    }).then(function (res) {
      if (!detail.classList.contains('pcard-open')) return; // closed meanwhile
      var link = res[0], g = res[1], a = res[2];
      var btnG = g ? '<a class="btn-wallet btn-wallet-google" href="' + esc(g) + '" target="_blank" rel="noopener"><i class="fa-brands fa-google-wallet"></i><span>Google Wallet</span></a>' : '';
      var btnA = a ? '<a class="btn-wallet btn-wallet-apple" href="' + esc(a) + '" target="_blank" rel="noopener"><i class="fa-brands fa-apple"></i><span>Apple Wallet</span></a>' : '';
      var order = isApplePlatform_() ? (btnA + btnG) : (btnG + btnA);
      body.innerHTML =
        '<div class="pwo-qr" id="pcardQr"></div>' +
        '<p class="pwo-scan">Scan to add — or share it so others can save your card.</p>' +
        '<div class="wallet-btns pwo-btns">' + (order || '') + '</div>';
      renderQr_($('#pcardQr'), link);
    }).catch(function (err) {
      body.innerHTML = '<p class="wallet-err">' + esc((err && err.message) || 'Could not prepare the card.') + '</p>';
    });
  }
  function hideProjectCardWallet() {
    var detail = $('#projDetail');
    if (!detail) return;
    detail.classList.remove('pcard-open');
    var ov = detail.querySelector('.proj-wallet-overlay');
    if (ov) ov.remove();
  }

  function projCardMap() {
    var grid = $('#projectsGrid'), m = {};
    if (grid) Array.prototype.forEach.call(grid.querySelectorAll('.project-card'), function (c) { m[c.getAttribute('data-slot')] = c; });
    return m;
  }
  function projFirstSlotPos() {
    var s0 = String(teamProjectsData()[0].slot);
    var c = projCardMap()[s0];
    return c ? { l: c.offsetLeft, t: c.offsetTop } : { l: 0, t: 0 };
  }
  // Lay the cards out as a stack at the first slot in `order` (front→back).
  // `skip` leaves one card untouched (mid-flip).
  function applyStack(order, skip) {
    var map = projCardMap(), pos = projFirstSlotPos();
    order.forEach(function (slot, i) {
      var c = map[String(slot)]; if (!c || c === skip) return;
      var front = i === 0;
      c.style.transform = 'translate(' + ((pos.l - c.offsetLeft) + i * 5) + 'px,' + ((pos.t - c.offsetTop) + i * 5) + 'px)' + (front ? '' : ' scale(0.985)');
      c.style.zIndex = String(60 - i * 2);
      c.classList.add('pc-stacked');
      c.classList.toggle('pc-front', front);
      c.classList.toggle('pc-behind', !front);
    });
  }

  // Fly every card onto the first slot (selected on top), freeing the rest of
  // the grid for the detail region.
  function openProject(slot, edit) {
    var grid = $('#projectsGrid'), detail = $('#projDetail');
    if (!grid || !detail || projSel != null) return;
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.project-card'));
    if (!cards.length) return;
    projSel = slot;
    projViewTab = 'details'; // always open on Details, not a stale Demo tab
    if (edit) startProjectEdit(slot); else { projEdit = false; projEditColor = ''; }
    projStack = [slot].concat(teamProjectsData().map(function (p) { return p.slot; }).filter(function (s) { return s !== slot; }));
    grid.classList.add('pp-open'); // enable the transition BEFORE moving cards
    applyStack(projStack);
    // detail fills the freed area: to the right of the first slot (multi-column)
    // or below it (single column)
    var fT = cards[0].offsetTop;
    var multiCol = cards.length > 1 && cards[1].offsetTop === fT;
    // extra breathing space between the card stack (+ its fan) and the detail
    if (multiCol) { detail.style.left = (cards[1].offsetLeft + 40) + 'px'; detail.style.top = '0'; }
    else { detail.style.left = '0'; detail.style.top = (fT + cards[0].offsetHeight + 26) + 'px'; }
    detail.hidden = false;
    detail.classList.toggle('has-video', projShowVideo(slot));
    detail.innerHTML = projectDetailHtml(slot);
    // member circles below the stacked card (left column)
    var strip = $('#projMembersStrip');
    if (strip && multiCol) {
      strip.style.left = cards[0].offsetLeft + 'px';
      strip.style.top = (fT + cards[0].offsetHeight + 46) + 'px';
      strip.hidden = false;
      strip.innerHTML = projMembersStripHtml(slot);
    }
    if (projEdit) { var ti = $('#projTitleIn'); if (ti) ti.focus(); wireProjectEditPreview(); }
  }

  // Deal the top card to the bottom of the deck (like flipping through cards),
  // bringing the next project to the front. Looping.
  var projFlipping = false;
  function flipStack() {
    if (projSel == null || projEdit || projStack.length < 2 || projFlipping) return;
    projFlipping = true;
    setTimeout(function () { projFlipping = false; }, 500);
    var leaving = projCardMap()[String(projStack[0])];
    var pos = projFirstSlotPos();
    var backIdx = projStack.length - 1;
    projStack = projStack.slice(1).concat(projStack[0]); // rotate front→back
    projSel = projStack[0];
    applyStack(projStack, leaving);   // advance the rest forward
    if (leaving) {
      var X = pos.l - leaving.offsetLeft, Y = pos.t - leaving.offsetTop;
      leaving.classList.remove('pc-front'); leaving.classList.add('pc-behind');
      leaving.style.zIndex = '70';
      leaving.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 1, 1)';
      leaving.style.transform = 'translate(' + X + 'px,' + (Y + 190) + 'px) scale(1.02)'; // slide down/out
      setTimeout(function () {          // …then tuck into the back
        leaving.style.transition = 'transform 0.36s cubic-bezier(0, 0, 0.2, 1)';
        leaving.style.transform = 'translate(' + (X + backIdx * 5) + 'px,' + (Y + backIdx * 5) + 'px) scale(0.985)';
        leaving.style.zIndex = String(60 - backIdx * 2);
        setTimeout(function () { if (leaving) leaving.style.transition = ''; }, 380);
      }, 260);
    }
    fadeDetail();
  }
  function fadeDetail() {
    var els = [$('#projDetail'), $('#projMembersStrip')];
    els.forEach(function (el) { if (el) { el.style.transition = 'opacity 0.18s ease'; el.style.opacity = '0'; } });
    setTimeout(function () {
      renderProjectDetail(); renderMembersStrip();
      els.forEach(function (el) { if (el) el.style.opacity = '1'; });
    }, 180);
  }
  function renderProjectDetail() {
    var detail = $('#projDetail');
    if (detail && projSel != null) {
      detail.classList.toggle('has-video', projShowVideo(projSel));
      detail.innerHTML = projectDetailHtml(projSel);
      if (projEdit) { var ti = $('#projTitleIn'); if (ti) ti.focus(); wireProjectEditPreview(); updateProjSaveState(); }
    }
  }
  // Live-preview title/description onto the stacked front card as the user types,
  // and keep the draft in sync so edits survive tab switches.
  function wireProjectEditPreview() {
    var card = $('#projectsGrid .pc-front');
    var h3 = card && card.querySelector('.pc-text h3');
    var pp = card && card.querySelector('.pc-text p');
    var ti = $('#projTitleIn'), de = $('#projDescIn'), fu = $('#projFullIn'), we = $('#projWebIn');
    if (ti) ti.oninput = function () { projEditDraft.title = ti.value; if (h3) h3.textContent = ti.value || 'Untitled project'; updateProjSaveState(); };
    if (de) de.oninput = function () { projEditDraft.description = de.value; if (pp) pp.textContent = de.value; updateProjSaveState(); };
    if (fu) fu.oninput = function () { projEditDraft.fullDescription = fu.value; updateProjSaveState(); };
    if (we) {
      var qp = $('#projQrPreview');
      var webTimer = null, webSeq = 0;
      // Validate reachability (server curls the URL). A live QR renders only for a
      // reachable link; an unreachable one shows a warning where the QR would be
      // and blocks Save until it's fixed or cleared.
      var checkWeb = function () {
        var v = we.value.trim();
        var enc = v && !/^https?:\/\//i.test(v) ? 'https://' + v : v; // match what we save
        if (!v || !looksLikeUrl(v)) {
          projWebStatus = 'empty';
          if (qp) qp.innerHTML = '';
          updateProjSaveState();
          return;
        }
        projWebStatus = 'checking';
        if (qp) qp.innerHTML = '<i class="fa-solid fa-spinner fa-spin proj-qr-check"></i>';
        updateProjSaveState();
        var seq = ++webSeq;
        A.api('check_url', { url: enc }).then(function (r) {
          if (seq !== webSeq) return; // superseded by a newer keystroke
          if (r && r.exists) { projWebStatus = 'ok'; if (qp) renderMiniQr_(qp, enc); }
          else { projWebStatus = 'bad'; if (qp) qp.innerHTML = '<i class="fa-solid fa-triangle-exclamation proj-qr-bad" title="This link didn’t respond — fix it or clear it to save."></i>'; }
          updateProjSaveState();
        }).catch(function () {
          if (seq !== webSeq) return;
          projWebStatus = 'bad';
          if (qp) qp.innerHTML = '<i class="fa-solid fa-triangle-exclamation proj-qr-bad" title="Could not verify this link — fix it or clear it to save."></i>';
          updateProjSaveState();
        });
      };
      we.oninput = function () {
        projEditDraft.website = we.value;
        updateProjSaveState();          // reflect dirtiness immediately
        clearTimeout(webTimer);
        webTimer = setTimeout(checkWeb, 500); // reachability check refines the gate
      };
      checkWeb(); // validate the loaded value immediately
    }
  }
  // Enable "Save changes" only when the draft differs from what was loaded — and
  // never while the website is unreachable. The pitch video is excluded (it
  // persists immediately on upload/remove, like the profile clip).
  function projEditDirty() {
    var b = projEditBaseline; if (!b) return false;
    var colorNow = projEditColor || b.color;
    return projEditDraft.title !== b.title ||
      projEditDraft.description !== b.description ||
      projEditDraft.fullDescription !== b.fullDescription ||
      projEditDraft.website !== b.website ||
      colorNow !== b.color;
  }
  function updateProjSaveState() {
    var btn = $('#projDetail [data-action="proj-save"]');
    if (!btn) return;
    var disable = projWebStatus === 'bad' || !projEditDirty();
    btn.disabled = disable;
    btn.classList.toggle('btn-disabled', disable);
  }
  function captureProjectDraft() {
    var ti = $('#projTitleIn'); if (ti) projEditDraft.title = ti.value;
    var de = $('#projDescIn'); if (de) projEditDraft.description = de.value;
    var fu = $('#projFullIn'); if (fu) projEditDraft.fullDescription = fu.value;
    var we = $('#projWebIn'); if (we) projEditDraft.website = we.value;
  }
  function startProjectEdit(slot) {
    var p = projectBySlot(slot) || {};
    projEdit = true; projEditColor = ''; projEditTab = 'details';
    // seed from the last saved reachability so Save is gated even before Details
    // is opened; the live check refines it once the website field is on screen
    projWebStatus = (p.website && !truthyStr(p.websiteOk)) ? 'bad' : 'ok';
    projEditDraft = { title: p.title || '', description: p.description || '', fullDescription: p.fullDescription || '', website: p.website || '' };
    projEditBaseline = { title: projEditDraft.title, description: projEditDraft.description, fullDescription: projEditDraft.fullDescription, website: projEditDraft.website, color: projColorClass(p, slot) };
  }
  function closeProject() {
    var grid = $('#projectsGrid'), detail = $('#projDetail');
    if (!grid || projSel == null) { projSel = null; return; }
    var strip = $('#projMembersStrip');
    if (detail) detail.classList.add('closing'); // fade the content out first…
    if (strip) { strip.style.transition = 'opacity 0.2s ease'; strip.style.opacity = '0'; }
    setTimeout(function () {                       // …then send the cards home
      // clear only transforms — keep .pp-open so the 0.52s transition animates
      Array.prototype.forEach.call(grid.querySelectorAll('.project-card'), function (c) { c.style.transform = ''; });
    }, 200);
    setTimeout(function () {                        // …then tidy up once settled
      Array.prototype.forEach.call(grid.querySelectorAll('.project-card'), function (c) {
        c.style.zIndex = ''; c.style.transition = ''; c.classList.remove('pc-stacked', 'pc-front', 'pc-behind');
      });
      grid.classList.remove('pp-open');
      if (detail) { detail.hidden = true; detail.innerHTML = ''; detail.classList.remove('closing'); detail.style.opacity = ''; }
      if (strip) { strip.hidden = true; strip.innerHTML = ''; strip.style.opacity = ''; strip.style.transition = ''; }
      projSel = null; projEdit = false; projEditColor = ''; projStack = [];
    }, 760);
  }
  function saveProject(slot, btn) {
    captureProjectDraft(); // draft holds the latest values even off the Details tab
    if (!(projEditDraft.title || '').trim()) { projEditTab = 'details'; renderProjectDetail(); toast('Title cannot be empty.', true); return; }
    var detail = $('#projDetail');
    if (detail) detail.classList.add('proj-busy'); // freeze the whole card during the save
    busy(btn, true);
    A.api('team_project_update', {
      slot: slot, title: projEditDraft.title,
      description: projEditDraft.description,
      fullDescription: projEditDraft.fullDescription,
      website: projEditDraft.website,
      color: projEditColor || undefined,
    }).then(function (r) {
      if (r && r.teamProjects) { state.data.teamProjects = r.teamProjects; A.writeCache(state.data); }
      projEdit = false; projEditColor = '';
      renderProjectDetail();
      var d2 = $('#projDetail'); if (d2) d2.classList.remove('proj-busy');
      // rebuild the stacked front card fully (title/desc/colour + QR presence),
      // preserving its stack transform, then (re)draw its QR
      var np = projectBySlot(slot);
      var card = $('#projectsGrid .project-card[data-slot="' + slot + '"]');
      if (card && np) {
        var tf = card.style.transform, z = card.style.zIndex;
        var tmp = document.createElement('div'); tmp.innerHTML = projectCardHtml(np);
        var fresh = tmp.firstChild;
        if (fresh) {
          fresh.style.transform = tf; fresh.style.zIndex = z;
          fresh.classList.add('pc-stacked', 'pc-front');
          card.replaceWith(fresh);
          renderProjectCardQRs();
        }
      }
      if (!truthyStr(np.websiteOk) && np.website) toast('Saved — but that website looked broken.', true);
      else toast('Project saved');
    }).catch(function (err) {
      toast(err.message, true); busy(btn, false);
      var d3 = $('#projDetail'); if (d3) d3.classList.remove('proj-busy');
    });
  }

  // Pick + validate (Full-HD 1920×1080, ≤60s, ≤32MB) + upload a team pitch video
  // to Drive. Shares the same rules as the profile intro video.
  function pickProjectVideo(slot, btn) {
    var status = $('#projVideoStatus');
    function setStatus(msg, isErr) { if (status) { status.textContent = msg; status.className = 'vid-status' + (isErr ? ' err' : ''); } if (isErr) toast(msg, true); }
    pickVideoFile(setStatus, function (file) { uploadProjectVideo(slot, file, btn, setStatus); });
  }
  // Same UX as the profile upload: indeterminate bar in the footer, action
  // buttons hidden while the single (upload + server-process) request runs.
  function projVideoBusy(on) {
    var pr = $('#projVideoProgress'); if (pr) { pr.hidden = !on; pr.classList.toggle('indet', on); }
    // hide the whole button row (upload/remove + cancel/save) so only the bar
    // shows in their place, and freeze the tabs (proj-busy = pointer-events off)
    var row = $('#projVideoFootRow'); if (row) row.hidden = on;
    var detail = $('#projDetail'); if (detail) detail.classList.toggle('proj-busy', on);
  }
  function uploadProjectVideo(slot, file, btn, setStatus) {
    videoActionPending = true;
    projVideoBusy(true);
    setStatus('Uploading your clip… keep this panel open (this can take up to a minute).', false);
    var reader = new FileReader();
    reader.onload = function () {
      A.api('upload_project_video', { slot: slot, data: reader.result, filename: file.name.replace(/\.[^.]+$/, '') })
        .then(function (r) {
          videoActionPending = false;
          if (r && r.teamProjects) { state.data.teamProjects = r.teamProjects; A.writeCache(state.data); }
          projVideoBusy(false); // lift the freeze before repainting
          renderProjectDetail(); // reflect "added" + the Demo tab now has a clip
          toast('Video uploaded');
        })
        .catch(function (err) { videoActionPending = false; projVideoBusy(false); setStatus(err.message || 'Upload failed', true); });
    };
    reader.onerror = function () { videoActionPending = false; projVideoBusy(false); setStatus('Could not read the file.', true); };
    reader.readAsDataURL(file);
  }
  // Remove the pitch clip — same busy/progress treatment as the upload.
  function removeProjectVideo(slot) {
    var status = $('#projVideoStatus');
    function setStatus(msg, isErr) { if (status) { status.textContent = msg; status.className = 'vid-status' + (isErr ? ' err' : ''); } if (isErr) toast(msg, true); }
    videoActionPending = true;
    projVideoBusy(true);
    setStatus('Removing your clip… keep this panel open.', false);
    A.api('team_project_update', { slot: slot, video: '' })
      .then(function (r) {
        videoActionPending = false;
        if (r && r.teamProjects) { state.data.teamProjects = r.teamProjects; A.writeCache(state.data); }
        projVideoBusy(false);
        renderProjectDetail();
        toast('Video removed');
      })
      .catch(function (err) { videoActionPending = false; projVideoBusy(false); setStatus(err.message || 'Could not remove the video', true); });
  }

  // --------------------------------------------------------------- tools
  // Shared resources scoped to the whole project (global) or one team (team).
  // Each is a card with optional description + a "link" and/or "secret" chip.
  var TOOL_SCOPES = {
    team: { label: 'Team', icon: 'fa-solid fa-user-group' },
    global: { label: 'Global', icon: 'fa-solid fa-globe' },
  };
  var toolsData = null;                          // { tools, canAddGlobal, canAddTeam, myTeam }
  var toolsUI = { filter: 'all', form: null, deleting: null };

  function viewTools() {
    if (!isMember()) return signInGate('tools');
    return '<div class="tools-view" id="toolsView">' +
      '<div class="tools-bar" id="toolsBar"></div>' +
      '<div class="tool-form-slot" id="toolFormSlot"></div>' +
      '<div class="tools-grid" id="toolsGrid">' +
      '<div class="empty" style="grid-column:1/-1"><span class="spin"></span></div></div>' +
      '</div>';
  }

  function toolById(id) {
    return ((toolsData && toolsData.tools) || []).filter(function (t) { return t.id === id; })[0] || null;
  }

  function initTools() {
    toolsUI.deleting = null; toolsUI.form = null;
    A.api('tools_list').then(function (r) {
      toolsData = r;
      if (!$('#toolsView')) return;
      renderToolsBar(); renderToolsGrid();
    }).catch(function () {
      if ($('#toolsGrid')) $('#toolsGrid').innerHTML =
        '<div class="empty" style="grid-column:1/-1"><i class="fa-solid fa-triangle-exclamation"></i>Could not load tools.</div>';
    });
  }
  function refreshTools() {
    return A.api('tools_list').then(function (r) { toolsData = r; renderToolsBar(); renderToolsGrid(); });
  }

  function renderToolsBar() {
    var bar = $('#toolsBar'); if (!bar || !toolsData) return;
    var tools = toolsData.tools || [];
    var counts = { all: tools.length, team: 0, global: 0 };
    tools.forEach(function (t) { counts[t.scope]++; });
    var chips = [['all', 'All'], ['team', 'Team'], ['global', 'Global']].map(function (f) {
      return '<button class="tool-fchip' + (toolsUI.filter === f[0] ? ' on' : '') + '" data-action="tool-filter" data-f="' + f[0] + '" data-s="' + f[0] + '">' +
        '<span class="tf-dot"></span>' + f[1] + ' <span class="tf-n">' + counts[f[0]] + '</span></button>';
    }).join('');
    var canAdd = toolsData.canAddTeam || toolsData.canAddGlobal;
    bar.innerHTML = '<div class="tool-filters">' + chips + '</div>' +
      (canAdd ? '<button class="btn btn-gradient btn-sm tools-add-btn" data-action="tool-add-open"><i class="fa-solid fa-plus"></i>Add tool</button>' : '');
  }

  function renderToolsGrid() {
    var g = $('#toolsGrid'); if (!g || !toolsData) return;
    var list = (toolsData.tools || []).filter(function (t) { return toolsUI.filter === 'all' || t.scope === toolsUI.filter; });
    if (!list.length) {
      g.innerHTML = '<div class="empty" style="grid-column:1/-1"><i class="fa-solid fa-toolbox"></i>' +
        ((toolsData.tools || []).length ? 'No ' + esc(toolsUI.filter) + ' tools yet.' : 'No tools yet.') +
        ((toolsData.canAddTeam || toolsData.canAddGlobal) ? '<br>Add one with the button above.' : '') + '</div>';
      return;
    }
    g.innerHTML = list.map(toolCardHTML).join('');
  }

  function toolCardHTML(t) {
    var sc = TOOL_SCOPES[t.scope] || TOOL_SCOPES.global;
    var chips = '';
    if (t.url) chips += '<a class="tool-chip" href="' + esc(t.url) + '" target="_blank" rel="noopener" title="' + esc(t.url) + '">link <i class="fa-solid fa-arrow-up-right-from-square"></i></a>';
    if (t.secret) chips += '<button class="tool-chip tool-copy" type="button" data-action="tool-copy" data-id="' + esc(t.id) + '" title="Copy secret">secret <i class="fa-regular fa-copy"></i></button>';
    var manage = t.canManage
      ? '<div class="tool-manage">' +
          '<button class="tool-mbtn" data-action="tool-edit" data-id="' + esc(t.id) + '" title="Edit"><i class="fa-solid fa-pen"></i></button>' +
          '<button class="tool-mbtn" data-action="tool-del" data-id="' + esc(t.id) + '" title="Remove"><i class="fa-regular fa-trash-can"></i></button></div>'
      : '';
    var confirm = toolsUI.deleting === t.id
      ? '<div class="tool-confirm"><span><i class="fa-solid fa-triangle-exclamation"></i>Remove this tool?</span>' +
          '<span class="tc-actions"><button class="btn btn-danger btn-sm" data-action="tool-del-yes" data-id="' + esc(t.id) + '"><span class="label">Remove</span><span class="spin"></span></button>' +
          '<button class="btn btn-ghost btn-sm" data-action="tool-del-no">Cancel</button></span></div>'
      : '';
    return '<div class="tool-card scope-' + t.scope + (t.canManage ? ' has-manage' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="tool-top"><div class="tool-title">' + esc(t.title) + '</div>' +
      '<span class="tool-scope"><i class="' + sc.icon + '"></i>' + sc.label + '</span>' + manage + '</div>' +
      (t.description ? '<div class="tool-desc">' + esc(t.description) + '</div>' : '') +
      '<div class="tool-foot">' + chips + '</div>' + confirm + '</div>';
  }

  // ---- add / edit form (inline) ----
  function openToolForm(tool) {
    toolsUI.form = { editing: tool || null }; toolsUI.deleting = null;
    renderToolsGrid(); renderToolForm();
    var slot = $('#toolFormSlot');
    if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function closeToolForm() {
    toolsUI.form = null;
    var slot = $('#toolFormSlot'); if (slot) slot.innerHTML = '';
  }
  function renderToolForm() {
    var slot = $('#toolFormSlot'); if (!slot) return;
    if (!toolsUI.form) { slot.innerHTML = ''; return; }
    slot.innerHTML = toolFormHTML(toolsUI.form.editing);
    wireToolForm();
  }

  function toolFormHTML(tool) {
    var editing = !!tool, d = tool || {};
    var canGlobal = !!(toolsData && toolsData.canAddGlobal);
    var canTeam = !!(toolsData && toolsData.canAddTeam);
    var scope = editing ? d.scope : (canTeam ? 'team' : 'global');
    var teamName = (toolsData && toolsData.myTeam && toolsData.myTeam.name) || 'your team';
    var scopeUI;
    if (editing) {
      var sc = TOOL_SCOPES[scope];
      scopeUI = '<div class="tf-field"><label>Who it’s for</label>' +
        '<div class="tf-scope-static scope-' + scope + '"><i class="' + sc.icon + '"></i>' + sc.label +
        (scope === 'team' ? ' · ' + esc(teamName) : ' · everyone in ' + esc(eventName())) + '</div></div>';
    } else {
      function opt(v, ic, nm, hint, locked) {
        return '<label class="tf-opt scope-' + v + (locked ? ' locked' : '') + '">' +
          '<input type="radio" name="toolScope" value="' + v + '"' + (scope === v ? ' checked' : '') + (locked ? ' disabled' : '') + '>' +
          '<span class="tf-box"><span class="tf-nm"><i class="' + ic + '"></i>' + nm + '</span><span class="tf-hint">' + hint + '</span></span></label>';
      }
      scopeUI = '<div class="tf-field"><label>Who is it for?</label><div class="tf-scope">' +
        opt('team', 'fa-solid fa-user-group', 'Team', esc(teamName), !canTeam) +
        opt('global', 'fa-solid fa-globe', 'Global', canGlobal ? 'Everyone in ' + esc(eventName()) : 'Organizers &amp; mentors only', !canGlobal) +
        '</div></div>';
    }
    return '<div class="tool-form">' +
      '<div class="tf-main">' + scopeUI +
      '<div class="tf-field"><div class="tf-lblrow"><label for="tfTitle">Title</label><span class="tf-count" id="tfcTitle"></span></div>' +
      '<input class="tf-input" id="tfTitle" maxlength="44" placeholder="e.g. Staging API token" value="' + esc(d.title || '') + '"></div>' +
      '<div class="tf-field"><div class="tf-lblrow"><label for="tfDesc">Description <span class="tf-optl">— optional</span></label><span class="tf-count" id="tfcDesc"></span></div>' +
      '<textarea class="tf-input" id="tfDesc" maxlength="100" placeholder="What it’s for, how to use it…">' + esc(d.description || '') + '</textarea></div>' +
      '<div class="tf-field"><label for="tfUrl">Link <span class="tf-optl">— optional</span></label>' +
      '<input class="tf-input" id="tfUrl" placeholder="https://…" value="' + esc(d.url || '') + '"></div>' +
      '<div class="tf-field tf-secret"><label for="tfSecret">Secret / token <span class="tf-optl">— optional</span></label>' +
      '<input class="tf-input" id="tfSecret" type="password" placeholder="Paste a token or value" value="' + esc(d.secret || '') + '">' +
      '<button type="button" class="tf-reveal" id="tfReveal" aria-label="Show"><i class="fa-regular fa-eye"></i></button></div>' +
      '</div>' +
      '<div class="tf-side">' +
      '<div class="tf-preview-lbl">Live preview</div>' +
      '<div class="tools-grid tf-preview" id="toolPreview"></div>' +
      '<div class="tf-actions">' +
      '<button class="btn btn-gradient btn-sm" id="tfSave" data-action="tool-save" disabled><span class="label">' + (editing ? 'Save changes' : 'Save tool') + '</span><span class="spin"></span></button>' +
      '<button class="btn btn-ghost btn-sm" data-action="tool-cancel">Cancel</button></div>' +
      '<p class="tf-hint2" id="tfHint"></p>' +
      '</div></div>';
  }

  function collectToolForm() {
    var scopeEl = document.querySelector('input[name=toolScope]:checked');
    var editing = toolsUI.form && toolsUI.form.editing;
    return {
      scope: editing ? editing.scope : (scopeEl ? scopeEl.value : 'team'),
      title: ($('#tfTitle') || {}).value ? $('#tfTitle').value.trim() : '',
      description: ($('#tfDesc') || {}).value ? $('#tfDesc').value.trim() : '',
      url: ($('#tfUrl') || {}).value ? $('#tfUrl').value.trim() : '',
      secret: ($('#tfSecret') || {}).value ? $('#tfSecret').value.trim() : '',
    };
  }
  function toolFormValid(f) { return !!f.title && !!(f.description || f.url || f.secret); }

  function wireToolForm() {
    var ttl = $('#tfTitle'), desc = $('#tfDesc'), url = $('#tfUrl'), sec = $('#tfSecret');
    if (!ttl) return;
    function upd() {
      var f = collectToolForm();
      var ct = $('#tfcTitle'), cd = $('#tfcDesc');
      if (ct) ct.textContent = ttl.value.length + ' / 44';
      if (cd) cd.textContent = desc.value.length + ' / 100';
      var save = $('#tfSave'), hint = $('#tfHint');
      var ok = toolFormValid(f);
      if (save) save.disabled = !ok;
      if (hint) hint.textContent = !f.title ? 'A title is required.'
        : !ok ? 'Add at least one of description, link or secret.' : 'Ready to save.';
      var pv = $('#toolPreview');
      if (pv) pv.innerHTML = toolCardHTML({ scope: f.scope, title: f.title || 'Untitled tool', description: f.description, url: f.url, secret: f.secret, canManage: false });
    }
    [ttl, desc, url, sec].forEach(function (el) { el.addEventListener('input', upd); });
    var scopeInputs = document.querySelectorAll('input[name=toolScope]');
    [].forEach.call(scopeInputs, function (el) { el.addEventListener('change', upd); });
    var rev = $('#tfReveal');
    if (rev) rev.addEventListener('click', function () {
      var p = sec.type === 'password'; sec.type = p ? 'text' : 'password';
      rev.innerHTML = p ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
    });
    upd();
  }

  // --------------------------------------------------------------- about
  // Public program page (#/about) — the brochure distilled: why, journey,
  // curriculum, who designed it, voices, where alumni ended up. Static.
  var AB_ALUMNI = [
    { img: 'aranya', name: 'Aranya Thanabalasingam', role: 'IBM Singapore' },
    { img: 'mukunthan', name: 'Tharmakulasingam Mukunthan', role: 'LSEG, Sri Lanka' },
    { img: 'rishadhy', name: 'Rishadhy Mjm', role: 'Atlas Labs' },
    { img: 'nivarthana-sandeepani', name: 'Nivarthana Sandeepani', role: 'Software Engineer, TIQRI' },
    { img: 'ishan-kawinda', name: 'Ishan Kawinda', role: 'Founder, Pengui' },
    { img: 'uvindu-dias', name: 'Uvindu Bigumjith Dias', role: 'Graduate Student, University of Canberra' },
  ];

  var AB_JOURNEY = [
    ['3-day bootcamp', 'Active, hands-on learning across disciplines — problem formulation, teamwork, creative ideation and prototyping with AI. Teams take an idea through the full cycle to innovation.'],
    ['Showcase event', 'A networking evening where teams present their outcomes to policy makers and industry leaders.'],
    ['Follow-up', 'High-potential teams continue into incubation — soft-skills development, career guidance and mentoring towards commercialisation, with accelerator partners. Every participant joins a private alumni network 150+ strong.'],
  ];

  var AB_CURRICULUM = [
    ['Discover', 'Challenging assumptions, knowledge and attitude'],
    ['Define', 'Reframing &amp; scoping a problem statement'],
    ['Develop', 'Ideation techniques'],
    ['Deliver', 'Prototyping — what do prototypes prototype'],
    ['AI', 'Overview of AI &middot; getting started with open LLMs &middot; agentic frameworks &middot; prototyping with AI'],
    ['Venture', 'Pivoting &middot; Lean Canvas &amp; lean start-up &middot; digital tools &middot; effective communication'],
  ];

  var AB_QUOTES = [
    { img: 'sunil-amarasuriya', name: 'Sunil Amarasuriya', role: 'Chairman, BP de Silva Group',
      text: 'It’s never too early to start thinking differently. I believe that everyone should take this opportunity to think how best they can use these methods to plan out their lives for the future.' },
    { img: 'uvindu-dias', name: 'Uvindu Bigumjith Dias', role: 'Workshop participant',
      text: 'Even a little change in the conventional minds of individuals in Sri Lanka would ultimately add up to build a better nation. I consider this workshop nothing but a treasure.' },
  ];

  function viewAbout() {
    return '<div class="about">' +
      '<header class="ab-hero">' +
      '<div class="hero-kicker">Innovation &middot; Creativity &middot; Entrepreneurship</div>' +
      '<h1>A step towards an <span class="grad">innovation ecosystem</span> in Sri&nbsp;Lanka</h1>' +
      '<p>ICE — the Design Innovation program — empowers Sri Lankan youth with creativity, innovation and entrepreneurship skills. A hands-on immersion in design thinking and Generative AI, built on the belief that a change in how young people think ripples into how a whole country builds.</p>' +
      '</header>' +

      '<div class="ab-stats">' +
      '<div class="stat"><b>30</b><span>participants</span></div>' +
      '<div class="stat"><b>6</b><span>universities</span></div>' +
      '<div class="stat"><b>14</b><span>facilitators</span></div>' +
      '<div class="stat"><b>40</b><span>hours in 3 days</span></div>' +
      '<span class="ab-stats-note">ICE2025</span>' +
      '</div>' +

      '<section class="ab-section">' +
      '<h2>The journey</h2>' +
      '<div class="ab-journey">' +
      AB_JOURNEY.map(function (s, i) {
        return '<div class="ab-step"><div class="ab-step-head"><span class="ab-step-n">' + (i + 1) + '</span>' +
          '<h3>' + s[0] + '</h3></div><p>' + s[1] + '</p></div>';
      }).join('') +
      '</div></section>' +

      '<section class="ab-section">' +
      '<h2>What participants learn</h2>' +
      '<p class="ab-sub">Participants identify, practice and apply the key elements of AI, design thinking and entrepreneurship — a foundation for a lifelong journey, not just three days.</p>' +
      '<div class="ab-curriculum">' +
      AB_CURRICULUM.map(function (c) {
        return '<div class="ab-cur"><h3>' + c[0] + '</h3><p>' + c[1] + '</p></div>';
      }).join('') +
      '</div></section>' +

      '<section class="ab-section">' +
      '<h2>Designed by Prof. Suranga Nanayakkara</h2>' +
      '<div class="ab-designer">' +
      '<img class="ab-portrait" src="assets/about/suranga.jpg" alt="Prof. Suranga Nanayakkara">' +
      '<p>Suranga has over 15 years of experience developing and teaching AI &amp; design thinking courses. He is an Associate Professor at the National University of Singapore, Honorary Professor at the University of Auckland, and was previously a Postdoctoral Associate at the MIT Media Lab. His work has been recognised with MIT TechReview’s TR35 award (Asia Pacific) and JCI Sri Lanka’s Ten Outstanding Young Professionals. ' +
      '<a href="https://suranga.info" target="_blank" rel="noopener">suranga.info <i class="fa-solid fa-arrow-up-right-from-square"></i></a></p>' +
      '</div></section>' +

      '<section class="ab-section">' +
      '<h2>Voices</h2>' +
      '<div class="ab-quotes">' +
      AB_QUOTES.map(function (q) {
        return '<figure class="ab-quote"><blockquote>&ldquo;' + q.text + '&rdquo;</blockquote>' +
          '<figcaption><img src="assets/about/' + q.img + '.jpg" alt="">' +
          '<span><b>' + q.name + '</b>' + q.role + '</span></figcaption></figure>';
      }).join('') +
      '</div></section>' +

      '<section class="ab-section">' +
      '<h2>Where alumni are now</h2>' +
      '<p class="ab-sub">Participants from workshops 2016&ndash;2025.</p>' +
      '<div class="ab-alumni">' +
      AB_ALUMNI.map(function (a) {
        return '<div class="ab-alum"><img src="assets/about/' + a.img + '.jpg" alt="">' +
          '<div class="ab-alum-body"><b>' + a.name + '</b><span>' + a.role + '</span></div></div>';
      }).join('') +
      '</div></section>' +
      '</div>';
  }

  // ------------------------------------------------------------- program
  // View-only 3-day agenda. Each day is a fixed-height flex column: cards
  // grow with their duration but never shrink below a readable minimum, and
  // flexbox renormalizes so every column fills the same height — dense
  // schedules with 5-minute items stay overlap-free without scrolling.
  // Parallel events sit side-by-side; idle gaps render as slim separators.
  // Renders a skeleton immediately; initProgram() swaps in calendar events.

  function programDayLabels() {
    var p = proj();
    var labels = [];
    if (p.startDate && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) {
      var d0 = new Date(p.startDate + 'T12:00:00');
      for (var i = 0; i < 3; i++) {
        var d = new Date(d0.getTime() + i * 864e5);
        labels.push('Day ' + (i + 1) + ' — ' +
          d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
      }
    } else {
      labels = ['Day 1', 'Day 2', 'Day 3'];
    }
    return labels;
  }

  // placeholder rows (flex-grow weights) per day — replaced by live data
  var PG_SKELETON = [
    [60, 30, 40, 90, 60, 45, 60, 90, 30],
    [35, 40, 100, 60, 60, 120, 30, 60],
    [45, 45, 75, 60, 120, 30, 60, 45, 90],
  ];

  function viewProgram() {
    if (!isMember()) return signInGate('the program');
    var labels = programDayLabels();
    var cols = labels.map(function (label, di) {
      var blocks = PG_SKELETON[di].map(function (g) {
        return '<div class="pg-event pg-skeleton" style="flex-grow:' + g + '"></div>';
      }).join('');
      return '<div class="pg-day"><div class="pg-day-head">' + esc(label) + '</div>' +
        '<div class="pg-day-body" data-di="' + di + '">' + blocks + '</div></div>';
    }).join('');
    return '<div class="program-wrap"><div class="program-grid">' + cols + '</div></div>';
  }

  function initProgram() {
    A.api('program').then(function (r) {
      if (!r.configured || !(r.events || []).length) return; // keep the skeleton
      if (!$('.program-grid')) return; // view changed meanwhile
      // Bucket by the CALENDAR's wall-clock date (startLocal: "yyyy-mm-ddThh:mm:ss")
      // so the agenda reads the same for every viewer, in any timezone.
      var p = proj();
      var dayKeys = [];
      if (p.startDate && /^\d{4}-\d{2}-\d{2}$/.test(p.startDate)) {
        var d0 = new Date(p.startDate + 'T12:00:00');
        for (var i = 0; i < 3; i++) {
          var d = new Date(d0.getTime() + i * 864e5);
          dayKeys.push(d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
        }
      } else {
        // no project dates: take the first three distinct event days
        r.events.forEach(function (ev) {
          var k = (ev.startLocal || ev.start).slice(0, 10);
          if (dayKeys.indexOf(k) === -1 && dayKeys.length < 3) dayKeys.push(k);
        });
      }
      function toMin(t) { return +t.slice(11, 13) * 60 + +t.slice(14, 16); }
      function card(ev, grow) {
        // Timings are intentionally hidden — the agenda shows event names only
        // (location still helps people find the room, so it stays).
        return '<div class="pg-event pg-real"' + (grow ? ' style="flex-grow:' + grow + '"' : '') + '>' +
          '<div class="pg-ev-title">' + esc(ev.title) + '</div>' +
          (ev.location ? '<div class="pg-ev-meta">' + esc(ev.location) + '</div>' : '') + '</div>';
      }
      $all('.pg-day-body').forEach(function (body) {
        var di = Number(body.getAttribute('data-di'));
        var evs = r.events.filter(function (ev) {
          return !ev.allDay && ev.startLocal && ev.startLocal.slice(0, 10) === dayKeys[di];
        }).sort(function (a, b) { return toMin(a.startLocal) - toMin(b.startLocal); });
        // cluster truly-overlapping events; they render side-by-side
        var groups = [];
        evs.forEach(function (ev) {
          var s = toMin(ev.startLocal), e = Math.max(s + 5, toMin(ev.endLocal));
          var g = groups[groups.length - 1];
          if (g && s < g.end) { g.items.push(ev); g.end = Math.max(g.end, e); }
          else groups.push({ start: s, end: e, items: [ev] });
        });
        var html = '';
        groups.forEach(function (g, gi) {
          var span = g.end - g.start;
          if (g.items.length === 1) html += card(g.items[0], span);
          else {
            html += '<div class="pg-group" style="flex-grow:' + span + '">' +
              g.items.map(function (ev) { return card(ev, 0); }).join('') + '</div>';
          }
          // idle stretches (≥ 30 min) show as a slim dashed separator
          var next = groups[gi + 1];
          if (next && next.start - g.end >= 30) html += '<div class="pg-gap"></div>';
        });
        body.innerHTML = html; // configured: empty days go clean, not skeleton
      });
    }).catch(function () { /* skeleton stays */ });
  }

  // Skills across the whole room — a 3D constellation: skills are nodes
  // (sized by how many people bring them), lines join skills that live in the
  // same person. Drag orbits like a 3D viewport; click a node to meet its
  // people. Sparse rooms are padded with dim "ghost" nodes from the
  // suggestion catalog so the maze reads well from day one.
  function viewSkills() {
    var d = state.data;
    if (!d) return skeletons();
    return '<div class="skills3d-wrap"><div class="aurora" aria-hidden="true"><span></span><span></span><span></span></div><canvas id="skillsCanvas"></canvas>' +
      '<aside class="skills-side" id="skillsSide">' +
      '<div class="ss-empty"><i class="fa-solid fa-wand-magic-sparkles"></i>' +
      'Tap a skill to explore it — what it is, who brings it, and what gets built with it.</div>' +
      '</aside></div>';
  }

  // ---- skills side panel: LLM blurb + people + projects for a picked skill
  function skillDescCache() {
    try { return JSON.parse(localStorage.getItem('ice.skilldesc') || '{}'); } catch (e) { return {}; }
  }

  function selectSkillPanel(name) {
    var side = $('#skillsSide');
    if (!side) return;
    var users = ((state.data && state.data.users) || []).filter(function (u) {
      return (u.skills || []).indexOf(name) !== -1;
    });
    var peopleHtml = users.length
      ? '<ul class="ss-people">' + users.map(function (u) {
          return '<li><a href="#/profile/' + esc(u.id) + '">' + avatar(u, 'avatar-sm') +
            '<span>' + esc(u.name) + '</span></a></li>';
        }).join('') + '</ul>'
      : '<p class="ss-none">No one has tagged this yet — people appear here as they register.</p>';
    // projects = the teams those people are in, mapped to the project cards
    var teams = homeTeams();
    var seen = {}, projItems = '';
    users.forEach(function (u) {
      teams.forEach(function (t, ti) {
        if ((t.members || []).indexOf(u.id) === -1 || seen[t.id]) return;
        seen[t.id] = 1;
        var p = DEMO_PROJECTS[ti];
        projItems += '<li>' + esc(p ? p.t : t.name) + ' <span class="ss-team">' + esc(t.name) + '</span></li>';
      });
    });
    var projHtml = projItems
      ? '<ul class="ss-projects">' + projItems + '</ul>'
      : '<p class="ss-none">Projects ' + tense('will appear', 'appear', 'appeared') +
        ' here once teams start building.</p>';
    side.innerHTML =
      '<h3 class="ss-title">' + esc(name) +
      (users.length ? '<span class="ss-count">' + users.length + '</span>' : '') + '</h3>' +
      '<p class="ss-desc thinking" id="ssDesc">&nbsp;</p>' +
      '<h4>People</h4>' + peopleHtml +
      '<h4>Projects</h4>' + projHtml +
      (users.length ? '<button type="button" class="btn btn-outline btn-sm ss-open" data-action="filter-skill" data-skill="' + esc(name) + '">See them in People</button>' : '');
    // description: localStorage first; otherwise Claude via the API (which
    // itself caches per skill server-side)
    var cached = skillDescCache()[name];
    var el = $('#ssDesc');
    if (cached) {
      el.textContent = cached;
      el.classList.remove('thinking');
      return;
    }
    // no cache → Claude is deriving it; churn gibberish in the meantime so the
    // wait reads as "loading" rather than an empty gap (stopped on response)
    var stopScramble = startScramble(el);
    A.api('skill_info', { skill: name }).then(function (r) {
      stopScramble();
      var out = $('#ssDesc');
      if (!out) return;
      out.classList.remove('thinking');
      out.textContent = r.text || '';
      if (r.text) {
        var c = skillDescCache();
        c[name] = r.text;
        try { localStorage.setItem('ice.skilldesc', JSON.stringify(c)); } catch (e) { /* quota */ }
      }
    }).catch(function () {
      stopScramble();
      var out = $('#ssDesc');
      if (out) { out.classList.remove('thinking'); out.textContent = ''; }
    });
  }

  // A fast-churning gibberish placeholder used as a text loading animation:
  // fills el with word-shaped random glyphs that reshuffle every frame until
  // the caller's stop() swaps in the real text. Self-cancels if el detaches.
  var SCRAMBLE_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%&*<>/{}[]=+';
  function startScramble(el) {
    if (!el) return function () {};
    // fixed word lengths so the block keeps a steady, text-like shape
    var lens = [];
    for (var i = 0; i < 16; i++) lens.push(3 + Math.floor(Math.random() * 7));
    var timer = setInterval(function () {
      if (!el.isConnected) { clearInterval(timer); return; }
      el.textContent = lens.map(function (n) {
        var w = '';
        for (var k = 0; k < n; k++) w += SCRAMBLE_GLYPHS.charAt(Math.floor(Math.random() * SCRAMBLE_GLYPHS.length));
        return w;
      }).join(' ');
    }, 45);
    return function () { clearInterval(timer); };
  }

  function initSkillsGraph(canvas) {
    var users = (state.data && state.data.users) || [];
    var counts = {}, pairW = {};
    users.forEach(function (u) {
      var sk = u.skills || [];
      sk.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
      for (var a = 0; a < sk.length; a++) for (var b = a + 1; b < sk.length; b++) {
        var key = sk[a] < sk[b] ? sk[a] + ' ' + sk[b] : sk[b] + ' ' + sk[a];
        pairW[key] = (pairW[key] || 0) + 1;
      }
    });
    var names = Object.keys(counts);
    // pad sparse rooms with ghost nodes from the suggestion catalog
    (C.SKILL_SUGGESTIONS || []).forEach(function (s) {
      if (names.length < 20 && !(s in counts)) { counts[s] = 0; names.push(s); }
    });
    var idx = {};
    var nodes = names.map(function (s, i) {
      idx[s] = i;
      // fibonacci sphere start positions
      var t = i / Math.max(1, names.length - 1);
      var phi = Math.acos(1 - 2 * t), theta = Math.PI * (1 + Math.sqrt(5)) * i;
      return {
        name: s, count: counts[s],
        x: Math.sin(phi) * Math.cos(theta), y: 1 - 2 * t, z: Math.sin(phi) * Math.sin(theta),
      };
    });
    var edges = Object.keys(pairW).map(function (k) {
      var p = k.split(' ');
      return { a: idx[p[0]], b: idx[p[1]], w: pairW[k], real: true };
    });
    // decorative lattice: each ghost node links to its 2 nearest neighbours
    nodes.forEach(function (n, i) {
      if (n.count > 0) return;
      var near = nodes.map(function (m, j) {
        if (i === j) return null;
        var dx = n.x - m.x, dy = n.y - m.y, dz = n.z - m.z;
        return { j: j, d: dx * dx + dy * dy + dz * dz };
      }).filter(Boolean).sort(function (a, b) { return a.d - b.d; }).slice(0, 2);
      near.forEach(function (m) { edges.push({ a: i, b: m.j, w: 1, real: false }); });
    });
    // a few force passes: real co-occurrence pulls together, crowding pushes apart
    for (var it = 0; it < 90; it++) {
      edges.forEach(function (e) {
        if (!e.real) return;
        var A = nodes[e.a], B = nodes[e.b];
        var k = 0.004 * Math.min(e.w, 4);
        A.x += (B.x - A.x) * k; A.y += (B.y - A.y) * k; A.z += (B.z - A.z) * k;
        B.x += (A.x - B.x) * k; B.y += (A.y - B.y) * k; B.z += (A.z - B.z) * k;
      });
      for (var i2 = 0; i2 < nodes.length; i2++) for (var j2 = i2 + 1; j2 < nodes.length; j2++) {
        var P = nodes[i2], Q = nodes[j2];
        var dx = Q.x - P.x, dy = Q.y - P.y, dz = Q.z - P.z;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.35 && d2 > 1e-6) {
          var push = 0.012 * (0.35 - d2) / Math.sqrt(d2);
          P.x -= dx * push; P.y -= dy * push; P.z -= dz * push;
          Q.x += dx * push; Q.y += dy * push; Q.z += dz * push;
        }
      }
      nodes.forEach(function (n) { // keep everyone near the unit shell
        var r = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z) || 1;
        var target = 1 + (r - 1) * 0.6;
        n.x *= target / r; n.y *= target / r; n.z *= target / r;
      });
    }

    var ctx = canvas.getContext('2d');
    // trackball rotation: a full 3x3 matrix, spun around the SCREEN's axes —
    // unlimited rotation in every direction, and dragging always follows the
    // pointer no matter which way up the maze currently is.
    var R = [0.83, 0, 0.56, 0.14, 0.97, -0.2, -0.54, 0.24, 0.8]; // ≈ old start view
    function preRot(a, axis) { // R = Rot(axis, a) · R
      var c = Math.cos(a), s = Math.sin(a), m = R.slice(), i;
      if (axis === 0) { // screen X
        for (i = 0; i < 3; i++) {
          R[3 + i] = c * m[3 + i] - s * m[6 + i];
          R[6 + i] = s * m[3 + i] + c * m[6 + i];
        }
      } else { // screen Y
        for (i = 0; i < 3; i++) {
          R[i] = c * m[i] + s * m[6 + i];
          R[6 + i] = -s * m[i] + c * m[6 + i];
        }
      }
    }
    var vyaw = 0, vpitch = 0, zoom = 1, calmUntil = 0, selected = -1;
    var dragging = false, moved = 0, lastX = 0, lastY = 0, mx = -1, my = -1, hover = -1;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var theme = {}, themeTick = 0;
    function readTheme() {
      var cs = getComputedStyle(document.documentElement);
      theme = {
        accent: cs.getPropertyValue('--color-accent').trim() || '#6100FF',
        text: cs.getPropertyValue('--text').trim() || '#0E0F11',
        faint: cs.getPropertyValue('--text-faint').trim() || '#AAAFB6',
        line: cs.getPropertyValue('--border-strong').trim() || '#C9D8E3',
      };
    }
    readTheme();

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      var r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left; my = e.clientY - r.top;
      if (!dragging) return;
      var dX = e.clientX - lastX, dY = e.clientY - lastY;
      moved += Math.abs(dX) + Math.abs(dY);
      vyaw = dX * 0.005; vpitch = -dY * 0.005; // Y inverted — pull down to tilt up
      preRot(vyaw, 1); preRot(vpitch, 0);
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', function () {
      dragging = false;
      vyaw = vpitch = 0;             // no inertia glide — release means stop
      calmUntil = Date.now() + 2000; // hold still for 2 s before the idle spin resumes
      if (moved < 6 && hover !== -1) {
        selected = hover;
        selectSkillPanel(nodes[hover].name);
      }
    });
    canvas.addEventListener('pointerleave', function () { mx = my = -1; });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = Math.max(0.5, Math.min(2.2, zoom * (e.deltaY > 0 ? 0.94 : 1.06)));
    }, { passive: false });

    var proj = new Array(nodes.length);
    function frame() {
      if (!canvas.isConnected) return; // view changed — stop the loop
      if (++themeTick % 40 === 0) readTheme();
      var wrap = canvas.parentElement;
      var W = wrap.clientWidth, H = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (!dragging) {
        var spin = (reduceMotion || Date.now() < calmUntil) ? 0 : 0.0008;
        preRot(spin + vyaw, 1); preRot(vpitch, 0);
        vyaw *= 0.95; vpitch *= 0.95;
      }
      // the maze owns the left ~2/3; the side panel lives in the right third
      var cx = W * 0.34;
      var scale = Math.min(W * 0.62, H) * 0.34 * zoom, camd = 3.2;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var x1 = R[0] * n.x + R[1] * n.y + R[2] * n.z;
        var y2 = R[3] * n.x + R[4] * n.y + R[5] * n.z;
        var z2 = R[6] * n.x + R[7] * n.y + R[8] * n.z;
        var f = camd / (camd - z2);
        proj[i] = { x: cx + x1 * scale * f, y: H / 2 + y2 * scale * f, f: f, z: z2 };
      }
      // hover pick (nearest projected node)
      hover = -1;
      if (mx >= 0) {
        var best = 1e9;
        for (var h = 0; h < nodes.length; h++) {
          var pr = (nodes[h].count > 0 ? 10 + Math.sqrt(nodes[h].count) * 7 : 5) * proj[h].f + 6;
          var ddx = proj[h].x - mx, ddy = proj[h].y - my, dd = ddx * ddx + ddy * ddy;
          if (dd < pr * pr && dd < best) { best = dd; hover = h; }
        }
      }
      canvas.style.cursor = dragging ? 'grabbing' : (hover !== -1 ? 'pointer' : 'grab');

      edges.forEach(function (e) {
        var A = proj[e.a], B = proj[e.b];
        var depth = Math.max(0.08, ((A.f + B.f) / 2 - 0.7) * 1.1);
        var hot = hover !== -1 && (e.a === hover || e.b === hover);
        ctx.strokeStyle = e.real ? theme.accent : theme.line;
        ctx.globalAlpha = Math.min(1, depth * (e.real ? 0.24 + 0.12 * Math.min(e.w, 3) : 0.16) * (hot ? 2.6 : 1));
        ctx.lineWidth = e.real ? Math.min(2.5, 0.8 + e.w * 0.5) : 0.8;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      });
      // nodes back-to-front
      var order = nodes.map(function (_, i) { return i; }).sort(function (a, b) { return proj[a].z - proj[b].z; });
      order.forEach(function (i3) {
        var n = nodes[i3], p = proj[i3];
        var real = n.count > 0;
        // popularity drives size: 1 person → 17px radius, 4 → 24, 9 → 31 …
        var r = (real ? 10 + Math.sqrt(n.count) * 7 : 4.5) * p.f;
        var depth = Math.max(0.15, (p.f - 0.7) * 1.4);
        ctx.globalAlpha = Math.min(1, depth + (hover === i3 ? 0.4 : 0));
        ctx.fillStyle = real ? theme.accent : theme.faint;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        if (hover === i3 || selected === i3) {
          ctx.strokeStyle = theme.accent; ctx.lineWidth = 2;
          ctx.globalAlpha = selected === i3 ? 1 : 0.9;
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2); ctx.stroke();
        }
        // real skills carry their tag count inside the node
        if (real) {
          ctx.globalAlpha = Math.min(1, depth + 0.25);
          ctx.fillStyle = '#fff';
          ctx.font = '700 ' + Math.round(Math.max(10, Math.min(r * 0.85, 18))) + 'px "neue-haas-grotesk-text","Helvetica Neue",sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(n.count, p.x, p.y);
          ctx.textBaseline = 'alphabetic';
        }
        var showLabel = real || p.f > 1 || hover === i3;
        if (showLabel) {
          ctx.globalAlpha = Math.min(1, depth * (real ? 1 : 0.65) + (hover === i3 ? 0.4 : 0));
          ctx.fillStyle = real ? theme.text : theme.faint;
          ctx.font = (hover === i3 ? '700 ' : '600 ') + Math.round((real ? 12.5 : 11) * p.f) + 'px "neue-haas-grotesk-text","Helvetica Neue",sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(n.name, p.x, p.y + r + 14 * p.f);
        }
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Full registry rows, lazily fetched for the admin Projects panel (global
  // admins only — the backend rejects everyone else). null = not loaded yet.
  var adminProjects = null;
  // Cross-project membership map (email -> [projectId]) for the People table's
  // Projects column, lazily fetched. null = not loaded yet.
  var userProjects = null;
  // Id of the person whose delete is being confirmed inline (in-row strip).
  // Only one at a time — while set, every other row's delete button is hidden.
  var deletingUserId = null;

  function projectsPanel(d) {
    if (!d.registryUrl) return ''; // only global admins manage projects
    var inner;
    if (!adminProjects) {
      inner = '<div class="skeleton" style="height:60px"></div>';
      A.api('admin_list_projects').then(function (r) {
        adminProjects = r.projects || [];
        if (location.hash === '#/admin') route();
      }).catch(function (err) { toast(err.message, true); });
    } else {
      var current = A.getProject();
      inner = '<div class="table-wrap proj-list"><table class="admin">' +
        '<thead><tr><th>Project</th><th>Status</th><th>Registration</th><th>Accounts</th><th>Storage</th><th></th></tr></thead><tbody>' +
        adminProjects.map(function (p) {
          var isProv = (p.status === 'provisioning');
          return '<tr><td><b>' + esc(p.name) + '</b> <span style="color:var(--text-muted);font-size:13px">' + esc(p.id) + '</span></td>' +
            '<td>' + (isProv
              ? '<span class="role-tag">setting up…</span>'
              : '<select class="input" style="padding:5px 10px;font-size:13px" data-action="proj-status" data-proj="' + esc(p.id) + '">' +
                ['active', 'test', 'archived'].map(function (s) { return '<option' + ((p.status || 'active') === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
                '</select>') + '</td>' +
            '<td><label style="cursor:pointer;white-space:nowrap"><input type="checkbox" data-action="proj-reg" data-proj="' + esc(p.id) + '"' + (p.registrationOpen === 'true' ? ' checked' : '') + (isProv ? ' disabled' : '') + '> open</label></td>' +
            '<td><label style="cursor:pointer;white-space:nowrap" title="Mint @designthinking.lk accounts on registration"><input type="checkbox" data-action="proj-prov" data-proj="' + esc(p.id) + '"' + (p.provisionAccounts === 'true' ? ' checked' : '') + (isProv ? ' disabled' : '') + '> mint</label></td>' +
            '<td class="proj-store">' +
            (p.dbId
              ? '<a href="https://docs.google.com/spreadsheets/d/' + esc(p.dbId) + '/edit" target="_blank" rel="noopener" title="Database — Google Sheet"><i class="fa-solid fa-table-cells-large sheet-ic"></i></a>'
              : '<span class="store-off" title="Sheet is created during setup"><i class="fa-solid fa-table-cells-large"></i></span>') +
            (p.uploadsFolderId
              ? '<a href="https://drive.google.com/drive/folders/' + esc(p.uploadsFolderId) + '" target="_blank" rel="noopener" title="Uploads — Google Drive"><i class="fa-brands fa-google-drive drive-ic"></i></a>'
              : '<span class="store-off" title="Folder is created during setup"><i class="fa-brands fa-google-drive"></i></span>') +
            '</td>' +
            '<td>' + (isProv
              ? '<span style="color:var(--text-muted);white-space:nowrap"><i class="fa-solid fa-spinner fa-spin"></i> Setting up…</span>'
              : p.id === current
                ? '<span class="role-tag admin">current</span>'
                : '<button class="btn btn-ghost btn-sm" data-action="switch-project-btn" data-proj="' + esc(p.id) + '"><i class="fa-solid fa-arrow-up-right-from-square"></i>Open</button>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var creating = creatingProject();
    if (creating) startProjectPolling(); // re-enter the waiting state after a refresh
    // Two sub-tabs in the header — "Projects" (the list) and "New project" (the
    // form) — plus the registry-sheet link on the right. The form is always one
    // click away; creating a project drops back to the Projects tab.
    return '<div class="panel" style="margin-bottom:22px;position:relative">' +
      '<div class="proj-panel-head">' +
      '<div class="proj-tabs">' +
      '<button class="proj-tab proj-tab-list' + (!showNewProject ? ' active' : '') + '" type="button" data-action="proj-tab-list"><i class="fa-solid fa-layer-group"></i>Projects</button>' +
      '<button class="proj-tab proj-tab-new' + (showNewProject ? ' active' : '') + '" type="button" data-action="proj-tab-new"><i class="fa-solid fa-plus"></i>New project</button>' +
      '</div>' +
      '<a class="btn btn-ghost btn-sm" href="' + esc(d.registryUrl) + '" target="_blank" rel="noopener">Registry sheet <i class="fa-solid fa-arrow-up-right-from-square"></i></a>' +
      '</div>' +
      (showNewProject ? newProjectCard() : inner) +
      (creating ? projectCreatingOverlay(creating) : '') +
      '</div>';
  }

  // Inline card under the projects list (no popup).
  var showNewProject = false;

  function newProjectCard() {
    // The subdomain IS the project name — one field. Sheet DB, Drive folder,
    // subdomain and admin access are all set up automatically on create.
    return '<form class="form new-project-card" id="projectForm">' +
      '<div class="field">' +
      '<div class="field-inline"><label for="projIdInput">Project name</label>' +
      '<input class="input proj-id-input" name="id" id="projIdInput" required maxlength="16" placeholder="ice2027" autocomplete="off" aria-describedby="projIdWarn">' +
      '<span class="input-suffix">.designthinking.lk</span></div>' +
      '<span id="projIdWarn" class="field-warn" hidden><i class="fa-solid fa-triangle-exclamation"></i> That name is already taken</span></div>' +
      '<div class="field field-inline"><label for="projTagline">Tagline <span class="hint">optional</span></label>' +
      '<input class="input" name="tagline" id="projTagline" maxlength="200" value="Innovation Creativity Entrepreneurship"></div>' +
      '<div class="form-status" id="projectFormStatus"></div>' +
      '<div class="form-actions"><button class="btn btn-gradient" type="submit" disabled><span class="label">Create project</span><span class="spin"></span></button>' +
      '<button class="btn btn-ghost" type="button" data-action="cancel-new-project">Cancel</button></div></form>';
  }

  // Slug rules, validated in JS (NOT via the HTML pattern attribute — browsers
  // now compile that with the regex `v` flag, which rejects a literal hyphen in
  // a character class unless escaped; a normal RegExp has no such issue).
  // 2–16 chars, lowercase letters/digits/hyphens, must start alphanumeric.
  var PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,15}$/;
  function validProjectId(v) { return PROJECT_ID_RE.test(String(v || '').trim().toLowerCase()); }

  // True if a project id is already registered — checked against the list the
  // admin panel already fetched (adminProjects), so no round-trip is needed.
  function projectIdTaken(v) {
    v = String(v || '').trim().toLowerCase();
    if (!v) return false;
    var list = adminProjects || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id).toLowerCase() === v) return true;
    }
    return false;
  }

  // ---- background project creation (survives refresh / navigation) ----
  // The single admin_create_project request finishes SERVER-SIDE even if the
  // client disconnects, so a marker in sessionStorage lets us block the panel
  // and poll for completion, re-entering that state after an accidental refresh.
  var CREATING_KEY = 'ice.creatingProject';
  var projectPollTimer = null;

  function creatingProject() {
    try { return sessionStorage.getItem(CREATING_KEY) || null; } catch (e) { return null; }
  }
  function setCreatingProject(slug) {
    try { slug ? sessionStorage.setItem(CREATING_KEY, slug) : sessionStorage.removeItem(CREATING_KEY); } catch (e) { /* private mode */ }
  }

  function projectCreatingOverlay(slug) {
    return '<div class="proj-creating-overlay">' +
      '<i class="fa-solid fa-spinner fa-spin"></i>' +
      '<div class="title">Creating ' + esc(slug) + '…</div>' +
      '<div class="hint">Setting up the database, storage, subdomain and access. This can take a minute — you can safely wait; refreshing or clicking away won’t interrupt it.</div>' +
      '</div>';
  }

  function stopProjectPolling() {
    if (projectPollTimer) { clearInterval(projectPollTimer); projectPollTimer = null; }
  }

  // Poll the registry until the in-flight project is fully provisioned. Covers
  // the case where the original create request's response was lost (disconnect
  // / refresh) — the row still turns active server-side.
  function startProjectPolling() {
    if (projectPollTimer) return;
    projectPollTimer = setInterval(function () {
      var slug = creatingProject();
      if (!slug) { stopProjectPolling(); return; }
      A.api('admin_list_projects').then(function (r) {
        var list = r.projects || [];
        var row = null;
        for (var i = 0; i < list.length; i++) { if (list[i].id === slug) { row = list[i]; break; } }
        if (row && row.status !== 'provisioning' && row.dbId) {
          setCreatingProject(null);
          stopProjectPolling();
          adminProjects = list;
          if (location.hash === '#/admin') route();
          refresh(); // pull the new project into the switcher
          toast('Project “' + slug + '” is ready');
        }
      }).catch(function () { /* transient — keep polling */ });
    }, 4000);
  }

  // ---- admin sections (one per tab) ----

  // Which user's "+ add role" options are expanded in the admin People table.
  var roleMenuFor = null;
  // In-flight add/remove: {userId, role, op}. The pending chip shows a
  // spinner and EVERY role control in the table freezes until the request
  // (and the follow-up data refresh) completes — no double-fires, no stale
  // clicks on other rows.
  var roleBusy = null;

  // One removable chip per role. Your own admin chip has no × — an admin can
  // never strip themselves of admin (the backend refuses too).
  function roleChipsHtml(u) {
    var isSelf = !!(me() && me().id === u.id);
    var roles = rolesOf(u);
    var busyHere = roleBusy && roleBusy.userId === u.id ? roleBusy : null;
    var lock = !!roleBusy;
    var html = roles.map(function (r) {
      var spinning = busyHere && busyHere.op === 'remove' && busyHere.role === r;
      var removable = !spinning && !(r === 'admin' && isSelf);
      return '<span class="role-tag ' + r + (spinning ? ' busy' : '') + '">' + r +
        (spinning
          ? '<i class="fa-solid fa-spinner fa-spin chip-spin"></i>'
          : removable
            ? '<button type="button" class="chip-x" data-action="role-remove" data-id="' + esc(u.id) + '" data-role="' + r + '"' + (lock ? ' disabled' : '') + ' title="Remove ' + r + ' role"><i class="fa-solid fa-xmark"></i></button>'
            : '') +
        '</span>';
    }).join('');
    if (busyHere && busyHere.op === 'add' && roles.indexOf(busyHere.role) === -1) {
      html += '<span class="role-tag ' + busyHere.role + ' busy">' + busyHere.role + '<i class="fa-solid fa-spinner fa-spin chip-spin"></i></span>';
    }
    if (!roles.length && !busyHere) html += '<span class="role-tag none" title="No access until a role is assigned — nothing is deleted">no access</span>';
    var addable = addableRoles(u);
    if (addable.length && !busyHere) {
      html += lock
        ? '<button type="button" class="role-addbtn" disabled><i class="fa-solid fa-plus"></i> add</button>'
        : roleMenuFor === u.id
          ? addable.map(function (r) {
              return '<button type="button" class="role-addopt" data-action="role-add" data-id="' + esc(u.id) + '" data-role="' + r + '">' + r + '</button>';
            }).join('') +
            '<button type="button" class="role-addbtn" data-action="role-menu" data-id="' + esc(u.id) + '" title="Cancel"><i class="fa-solid fa-xmark"></i></button>'
          : '<button type="button" class="role-addbtn" data-action="role-menu" data-id="' + esc(u.id) + '"><i class="fa-solid fa-plus"></i> add</button>';
    }
    return '<div class="role-cell">' + html + '</div>';
  }

  // ---- invite composer (inline card above the People table) ----
  // The invites tab is the registration allowlist: only invited emails can
  // register, with the role fixed at invite time. null = composer closed;
  // open: { role: 'participant'|'mentor', chips: [emails] }.
  var inviteCard = null;
  var INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Is this email already in the project — a pending invite (either role) or a
  // registered member? Returns 'invited' | 'registered' | null. Used to block
  // re-inviting an address before it's accepted (the app also forbids one email
  // being both participant and mentor, so any existing invite blocks it).
  function inviteEmailStatus(email) {
    var e = String(email || '').toLowerCase();
    var d = state.data || {};
    var us = d.users || [];
    for (var i = 0; i < us.length; i++) if (String(us[i].email || '').toLowerCase() === e) return 'registered';
    var inv = d.invites || [];
    for (var j = 0; j < inv.length; j++) if (String(inv[j].email || '').toLowerCase() === e) return 'invited';
    return null;
  }

  function inviteCardHtml() {
    var c = inviteCard;
    var n = c.chips.length;
    // The frozen (sending) state must survive a full re-render — the periodic
    // refresh() can rebuild the view while the batch is still in flight.
    var frozen = !!c.sending;
    var dis = frozen ? ' disabled' : '';
    var dupCount = 0;
    var chips = c.chips.map(function (em, i) {
      var st = inviteEmailStatus(em);
      if (st) dupCount++;
      var tip = st === 'registered' ? 'Already a member' : st === 'invited' ? 'Already invited' : '';
      return '<span class="chip static echip' + (st ? ' echip-bad' : '') + '"' + (tip ? ' title="' + tip + '"' : '') + '>' +
        (st ? '<i class="fa-solid fa-triangle-exclamation echip-warn"></i>' : '') + esc(em) +
        '<button type="button" class="chip-x" data-action="invite-chip-x" data-idx="' + i + '" title="Remove"' + dis + '><i class="fa-solid fa-xmark"></i></button></span>';
    }).join('');
    // Send is blocked while any address is already invited/registered — remove it first.
    var canSend = n > 0 && dupCount === 0 && !frozen;
    return '<div class="panel invite-card">' +
      '<h3><i class="fa-regular fa-paper-plane"></i>Invite ' + (c.role === 'mentor' ? 'mentors' : c.role === 'catalyst' ? 'catalysts' : c.role === 'admin' ? 'admins' : 'participants') + '</h3>' +
      '<div class="tag-input invite-input" data-action="invite-focus">' + chips +
      '<input id="inviteEntry" type="text" autocomplete="off" spellcheck="false" value="' + esc(c.text || '') + '" placeholder="' + (n ? 'Add another…' : 'Type or paste email addresses…') + '"' + dis + '>' +
      '</div>' +
      (dupCount
        ? '<p class="invite-hint invite-hint-bad"><i class="fa-solid fa-triangle-exclamation"></i>' + dupCount + (dupCount === 1 ? ' address is' : ' addresses are') + ' already invited or a member — remove ' + (dupCount === 1 ? 'it' : 'them') + ' to send.</p>'
        : '<p class="invite-hint">Each address gets an invitation email to sign in and complete registration as a ' + c.role + '. Only invited addresses can register.</p>') +
      '<div class="form-actions" style="margin-top:14px">' +
      '<button class="btn btn-gradient btn-sm' + (frozen ? ' loading' : '') + '" data-action="invite-send"' + (canSend ? '' : ' disabled') + '><span class="label"><i class="fa-regular fa-paper-plane"></i> Send ' + (n ? n + ' ' : '') + 'invitation' + (n === 1 ? '' : 's') + '</span><span class="spin"></span></button>' +
      '<button class="btn btn-ghost btn-sm" data-action="invite-cancel"' + dis + '>Cancel</button>' +
      '</div></div>';
  }

  // Free text → chips (valid, deduped, lowercased); invalid tokens are handed
  // back so they can stay in the input, marked red.
  function inviteAbsorb(text) {
    var bad = [];
    String(text || '').split(/[\s,;]+/).forEach(function (tk) {
      tk = tk.trim().toLowerCase();
      if (!tk) return;
      if (!INVITE_EMAIL_RE.test(tk)) { if (bad.indexOf(tk) === -1) bad.push(tk); return; }
      if (inviteCard.chips.indexOf(tk) === -1) inviteCard.chips.push(tk);
    });
    return bad;
  }

  // Re-render only the composer — a full route() would drop the input focus.
  // `leftover` = invalid tokens that stay in the input, marked red. The text
  // also lives in inviteCard.text so the periodic refresh() re-render (which
  // rebuilds the whole view) can't wipe a half-typed address.
  function renderInviteCard(leftover) {
    if (!inviteCard) return;
    inviteCard.text = leftover || '';
    var el = document.querySelector('.invite-card');
    if (!el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = inviteCardHtml();
    el.replaceWith(tmp.firstElementChild);
    var input = $('#inviteEntry');
    if (input) {
      if (leftover) input.classList.add('bad');
      input.focus();
    }
  }

  function adminPeopleSection(d) {
    var users = (d.users || []).slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    // Lazily load the cross-project membership map for the Projects column.
    if (!userProjects) {
      A.api('admin_user_projects').then(function (r) {
        userProjects = r.memberships || {};
        if (location.hash === '#/admin') route();
      }).catch(function () { userProjects = {}; });
    }
    var curProj = A.getProject();
    // Project chips for one person: all projects they're in (current first),
    // falling back to just the current project until the map loads.
    function projChips(u) {
      var ids = (userProjects && userProjects[String(u.email || '').toLowerCase()]) || [curProj];
      if (ids.indexOf(curProj) === -1) ids = [curProj].concat(ids);
      ids = ids.slice().sort(function (a, b) { return a === curProj ? -1 : b === curProj ? 1 : a.localeCompare(b); });
      return '<div class="proj-chips">' + ids.map(function (id) {
        return '<span class="proj-chip' + (id === curProj ? ' current' : '') + '">' + esc(id) + '</span>';
      }).join('') + '</div>';
    }
    var regEmails = {};
    users.forEach(function (u) { if (u.email) regEmails[String(u.email).toLowerCase()] = true; });
    // Allowlist rows nobody has registered against yet → pending rows.
    var pending = (d.invites || [])
      .filter(function (i) { return !regEmails[String(i.email).toLowerCase()]; })
      .sort(function (a, b) { return (a.email || '').localeCompare(b.email || ''); });
    var head = '<div class="invite-bar">' +
      '<button class="btn btn-outline btn-sm" data-action="invite-open" data-role="participant"><i class="fa-solid fa-user-plus"></i>Invite participants</button>' +
      '<button class="btn btn-outline btn-sm" data-action="invite-open" data-role="mentor"><i class="fa-solid fa-user-tie"></i>Invite mentors</button>' +
      '<button class="btn btn-outline btn-sm" data-action="invite-open" data-role="catalyst"><i class="fa-solid fa-bolt"></i>Invite catalysts</button>' +
      '<button class="btn btn-outline btn-sm" data-action="invite-open" data-role="admin"><i class="fa-solid fa-shield-halved"></i>Invite admins</button>' +
      '</div>' + (inviteCard ? inviteCardHtml() : '');
    if (!users.length && !pending.length) {
      return head + '<div class="empty"><i class="fa-solid fa-users"></i>Nobody has registered yet.</div>';
    }
    var rows = users.map(function (u) {
      // Inline delete confirm: the whole row becomes one full-width confirm
      // strip (a single colspan cell). We AVOID an absolute overlay anchored to
      // the <tr>: Safari/WebKit won't let a table row be a positioning context,
      // so the overlay escaped and covered the entire screen.
      if (deletingUserId === u.id) {
        return '<tr class="confirm-row"><td colspan="6">' +
          '<div class="row-confirm">' +
          '<span class="row-confirm-text"><i class="fa-solid fa-triangle-exclamation"></i>' +
          '<span>Remove <b>' + esc(u.name) + '</b> from this project? Profile, skills, teams, messages &amp; photo here are deleted — their @designthinking.lk account and any other projects are kept.</span></span>' +
          '<span class="row-confirm-actions">' +
          '<button class="btn btn-danger btn-sm" data-action="del-user-confirm" data-id="' + esc(u.id) + '"><span class="label">Delete</span><span class="spin"></span></button>' +
          '<button class="btn btn-ghost btn-sm" data-action="del-user-cancel">Cancel</button>' +
          '</span></div></td></tr>';
      }
      return '<tr><td style="display:flex;align-items:center;gap:10px">' + avatar(u, 'avatar-sm') +
        '<a href="#/profile/' + esc(u.id) + '">' + esc(u.name) + '</a></td>' +
        '<td>' + esc(u.email || '') +
        (u.workEmail ? '<div class="dt-mail" title="Workshop @designthinking.lk account"><i class="fa-regular fa-comment-dots"></i>' + esc(u.workEmail) + '</div>' : '') +
        '</td>' +
        '<td>' + projChips(u) + '</td>' +
        '<td>' + roleChipsHtml(u) + '</td>' +
        '<td><span class="ob-tag registered"><i class="fa-solid fa-circle-check"></i>Registered</span></td>' +
        // While a delete is being confirmed, other delete buttons are made
        // invisible (visibility:hidden) — they still occupy their space so the
        // action column width never changes, but can't be clicked.
        '<td><button class="btn btn-ghost btn-sm" data-action="del-user" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '"' + (deletingUserId ? ' style="visibility:hidden" tabindex="-1"' : '') + '><i class="fa-regular fa-trash-can"></i></button></td></tr>';
    }).join('');
    var invRows = pending.map(function (i) {
      var roleTag = i.role === 'mentor' ? 'mentor' : i.role === 'catalyst' ? 'catalyst' : i.role === 'admin' ? 'admin' : 'participant';
      return '<tr class="invite-row"><td style="display:flex;align-items:center;gap:10px">' +
        '<span class="avatar avatar-sm invite-avatar"><i class="fa-regular fa-envelope"></i></span><span class="invite-noname">—</span></td>' +
        '<td>' + esc(i.email) + '</td>' +
        '<td></td>' +
        '<td><div class="role-cell"><span class="role-tag ' + roleTag + '">' + roleTag + '</span></div></td>' +
        '<td><span class="ob-tag invited"><i class="fa-regular fa-clock"></i>Invited</span>' +
        '<button class="btn btn-ghost btn-sm" data-action="invite-resend" data-id="' + esc(i.id) + '" data-email="' + esc(i.email) + '" title="Resend the invitation email"><span class="label"><i class="fa-regular fa-paper-plane"></i> Resend</span><span class="spin"></span></button></td>' +
        '<td><button class="btn btn-ghost btn-sm" data-action="invite-revoke" data-id="' + esc(i.id) + '" data-email="' + esc(i.email) + '" title="Revoke invitation"' + (deletingUserId ? ' style="visibility:hidden" tabindex="-1"' : '') + '><i class="fa-regular fa-trash-can"></i></button></td></tr>';
    }).join('');
    return head + '<div class="table-wrap"><table class="admin people"><thead><tr><th>Name</th><th>Email</th><th>Projects</th><th>Roles</th><th>Onboarding</th><th></th></tr></thead>' +
      '<tbody>' + rows + invRows + '</tbody></table></div>';
  }

  function adminEventSection(d) {
    var p = proj();
    return '<div class="panel" style="margin-bottom:22px"><h3><i class="fa-solid fa-toggle-on"></i>Event settings <span style="font-weight:400;color:var(--text-muted);font-size:14px">— ' + esc(eventName()) + '</span></h3>' +
      '<label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" id="regToggle" ' + (d.registrationOpen ? 'checked' : '') + ' data-action="toggle-reg"> Registration open</label></div>' +
      '<div class="panel" style="margin-bottom:22px"><h3><i class="fa-regular fa-calendar"></i>Event dates</h3>' +
      '<div class="date-range">' +
      '<label>Start <input type="date" class="input" id="evStart" value="' + esc(p.startDate || '') + '"></label>' +
      '<label>End <input type="date" class="input" id="evEnd" value="' + esc(p.endDate || '') + '"></label>' +
      '<button class="btn btn-outline btn-sm" data-action="save-dates"><span class="label"><i class="fa-regular fa-floppy-disk"></i> Save dates</span><span class="spin"></span></button>' +
      '</div>' +
      '<p class="hint" style="margin:10px 0 0;color:var(--text-muted);font-size:13px">Shown on the home page later.</p></div>' +
      '<div class="panel"><h3><i class="fa-solid fa-bullhorn"></i>Announcements</h3>' +
      '<button class="btn btn-outline btn-sm" data-action="new-ann"><i class="fa-solid fa-plus"></i>New announcement</button> ' +
      '<a class="btn btn-ghost btn-sm" href="#/announcements">Manage on the news page</a></div>';
  }

  // ---- Resources tab: directory of everything the deployment is built on ----
  // Static infra links are hardcoded (they identify the deployment itself);
  // storage links come from bootstrap so they follow the active project.
  function adminResourcesSection(d) {
    var C = window.ICE_CONFIG || {};
    var slug = proj().id || A.getProject();
    // isProj marks links scoped to the active project (a slug chip flags them —
    // they change when a new project like ice2027 takes over); unflagged links
    // are platform-wide.
    function link(icon, label, href, isProj) {
      if (!href) return '';
      return '<a class="res-link" href="' + esc(href) + '" target="_blank" rel="noopener">' +
        '<i class="' + icon + '"></i><span>' + esc(label) + '</span>' +
        (isProj ? '<span class="res-chip" title="Project-specific — follows the active project">' + esc(slug) + '</span>' : '') +
        '<i class="fa-solid fa-arrow-up-right-from-square ext"></i></a>';
    }
    function group(icon, title, links) {
      var inner = links.join('');
      if (!inner) return '';
      return '<div class="res-group"><h4><i class="' + icon + '"></i>' + esc(title) + '</h4>' + inner + '</div>';
    }
    return '<div class="res-grid">' +
      group('fa-solid fa-globe', 'Site & DNS', [
        link('fa-solid fa-globe', 'Live site', /^https?:/i.test(siteUrl()) ? siteUrl() : 'https://' + siteUrl(), true),
        link('fa-brands fa-cloudflare', 'Cloudflare DNS', 'https://dash.cloudflare.com'),
      ]) +
      group('fa-brands fa-github', 'GitHub', [
        link('fa-brands fa-github', 'Frontend repo', 'https://github.com/designthinking-lk/ice-central-web'),
        link('fa-brands fa-github', 'Backend repo', 'https://github.com/ice2k26/ice-central-api'),
      ]) +
      group('fa-solid fa-scroll', 'Apps Script', [
        link('fa-solid fa-scroll', 'Auth script', 'https://script.google.com/d/1zRA0sI_eoVd9FMHyogA_lcwvHA9WqjrT5PoS1tYNZ8c_Ar5cmn-_H1jb/edit'),
        link('fa-solid fa-scroll', 'API script', 'https://script.google.com/d/1pc6ZD0z-8P8bv-3NOH4dXXnb8TDEiu0i34q_xRZmJXFqrPwwV0NL7MDn/edit'),
        link('fa-solid fa-bolt', 'Auth endpoint', C.AUTH_URL),
        link('fa-solid fa-bolt', 'API endpoint', C.API_URL),
      ]) +
      group('fa-solid fa-cloud', 'Google Cloud', [
        link('fa-solid fa-cloud', 'design-thinking-502504', 'https://console.cloud.google.com/home/dashboard?project=design-thinking-502504'),
        link('fa-regular fa-comments', 'Chat API config', 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=design-thinking-502504'),
        link('fa-solid fa-users-gear', 'Workspace admin', 'https://admin.google.com'),
      ]) +
      group('fa-solid fa-database', 'Data', [
        link('fa-solid fa-table', 'Projects registry', d.registryUrl),
        link('fa-solid fa-table', 'Project database', d.dbUrl, true),
        link('fa-brands fa-google-drive', 'Uploads folder', d.uploadsUrl, true),
      ]) +
      group('fa-solid fa-palette', 'Frontend assets', [
        link('fa-solid fa-font', 'Adobe Fonts kit', 'https://use.typekit.net/zws2qzx.css'),
        link('fa-brands fa-font-awesome', 'Font Awesome 6.7.2', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css'),
        link('fa-solid fa-palette', 'AHLab brand kit', 'https://cdn.ahlab.org/'),
      ]) +
      '</div>';
  }

  // ---- Teams tab: assign every registered person into Team A–F ----
  // Capacity per team: 5 participants + 2 mentors (the backend enforces the
  // same caps, so a stale board can never oversubscribe a team).
  var TEAM_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  var TEAM_CAP = { participant: 5, mentor: 2 };
  // Compact team labels for the board: Team A → T1 … Team F → T6. Data/name
  // stay letter-based; only the visible admin labels are numbered.
  function teamNum(L) { return String(TEAM_LETTERS.indexOf(L) + 1); }
  function teamShort(L) { return 'T' + teamNum(L); }

  // Participant chip → participant slot; mentor chip (or admin-only) → mentor slot.
  function teamSlot(u) { return hasRoleU(u, 'participant') ? 'participant' : 'mentor'; }
  // Assignable to a team = holds a community role (an admin with a
  // participant/mentor chip plays that role; admin-only people sit out).
  function teamAssignable(u) { return hasRoleU(u, 'participant') || hasRoleU(u, 'mentor'); }

  // IDs of assignable people not on any Team A–F — the current unassigned pool.
  // Used by the header's master select (render recomputes the same set).
  function unassignedPoolIds() {
    var d = state.data;
    if (!d) return [];
    var inTeam = {};
    (d.teams || []).forEach(function (t) {
      if (!/^team [a-f]$/i.test(String(t.name || '').trim())) return;
      (t.members || []).forEach(function (id) { inTeam[id] = true; });
    });
    return (d.users || []).filter(function (u) { return teamAssignable(u) && !inTeam[u.id]; })
      .map(function (u) { return u.id; });
  }

  function adminTeamsSection(d) {
    var users = d.users || [];
    if (!users.length) return '<div class="empty"><i class="fa-solid fa-users"></i>Nobody has registered yet.</div>';
    var byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    // The letter teams as they exist in the data (rows are created server-side
    // on first assignment), the letter each user sits in, and per-team counts.
    var assigned = {}; // userId -> letter
    var counts = {};   // letter -> { participant, mentor }
    var teamOf = {};   // letter -> { mentors: [], participants: [] }
    var teamRow = {};  // letter -> team object (for id + live score)
    TEAM_LETTERS.forEach(function (L) {
      counts[L] = { participant: 0, mentor: 0 };
      teamOf[L] = { mentor: [], participant: [] };
      var wanted = ('team ' + L).toLowerCase();
      (d.teams || []).forEach(function (t) {
        if (String(t.name || '').trim().toLowerCase() !== wanted) return;
        teamRow[L] = t;
        (t.members || []).forEach(function (id) {
          var u = byId[id];
          if (!u) return;
          var s = teamSlot(u);
          assigned[u.id] = L;
          counts[L][s]++;
          teamOf[L][s].push(u);
        });
      });
    });

    // Slots stack one-per-row now, so the full name fits (a mentor keeps the
    // compact tie icon rather than a wider pill).
    function memberRow(u, L) {
      // While this person's own remove is in flight, freeze just their row:
      // swap the × for a spinner so it's clear who is being moved.
      var busy = teamBusyId === u.id;
      var removeCtl = busy
        ? '<span class="tb-remove tb-remove-busy" title="Removing…"><i class="fa-solid fa-spinner fa-spin"></i></span>'
        : '<button class="tb-remove" type="button" data-action="unassign-team" data-id="' + esc(u.id) + '"' +
          (teamBusy ? ' disabled' : '') + ' title="Remove from ' + teamShort(L) + '"><i class="fa-solid fa-xmark"></i></button>';
      return '<div class="tb-member' + (busy ? ' tb-member-busy' : '') + '">' + avatar(u, 'avatar-sm') +
        '<a href="#/profile/' + esc(u.id) + '" title="' + esc(u.name) + '">' + esc(u.name) + '</a>' +
        (teamSlot(u) === 'mentor' ? '<i class="fa-solid fa-user-tie tb-tie" title="mentor"></i>' : '') +
        removeCtl + '</div>';
    }

    // Unassigned pool — only people with a community role; mentors first.
    var pool = users.filter(function (u) { return teamAssignable(u) && !assigned[u.id]; })
      .sort(function (a, b) {
        var s = teamSlot(a) === teamSlot(b) ? 0 : (teamSlot(a) === 'mentor' ? -1 : 1);
        return s || (a.name || '').localeCompare(b.name || '');
      });
    var poolIds = {};
    pool.forEach(function (u) { poolIds[u.id] = true; });
    // Selection only ever holds people still in the pool (assigning drops them).
    Object.keys(teamSel).forEach(function (id) { if (!poolIds[id]) delete teamSel[id]; });
    var selIds = Object.keys(teamSel);
    var selCount = selIds.length;
    // Slots the current selection needs, split by kind — an "Add Here" only
    // shows on a team that can seat every selected person at once.
    var need = { participant: 0, mentor: 0 };
    selIds.forEach(function (id) { if (byId[id]) need[teamSlot(byId[id])]++; });

    // Slots flow into a 2-column grid: [M M] [P P] [P P] [P –] — 4 rows. The
    // always-empty last cell (row 4, col 2) holds the "Add Here" target.
    var cards = TEAM_LETTERS.map(function (L) {
      var slots = '';
      teamOf[L].mentor.forEach(function (u) { slots += memberRow(u, L); });
      for (var i = counts[L].mentor; i < TEAM_CAP.mentor; i++) slots += '<div class="tb-member tb-empty">mentor</div>';
      teamOf[L].participant.forEach(function (u) { slots += memberRow(u, L); });
      for (var j = counts[L].participant; j < TEAM_CAP.participant; j++) slots += '<div class="tb-member tb-empty">participant</div>';
      var freeM = TEAM_CAP.mentor - counts[L].mentor;
      var freeP = TEAM_CAP.participant - counts[L].participant;
      var full = freeM <= 0 && freeP <= 0;
      // The selection fits only if this team has room for its mentors AND its
      // participants — 3 mentors never fit (cap 2); 2 mentors fit an empty team.
      var canFit = selCount > 0 && !teamBusy && freeM >= need.mentor && freeP >= need.participant;
      // "Add Here" rides in the header next to the team name (saves a slot row).
      var headExtra = canFit
        ? '<button class="tb-addhere" type="button" data-action="tb-add-here" data-team="' + L + '"' +
            ' title="Add the ' + selCount + ' selected here"><i class="fa-solid fa-plus"></i> Add Here</button>'
        : (full ? '<span class="tb-fulltag"><i class="fa-solid fa-circle-check"></i> Full</span>' : '');
      var tr = teamRow[L];
      var score = tr ? (Number(tr.score) || 0) : 0;
      // Live team score — shown on every member's wallet card. Disabled until
      // the team row exists (created on first assignment).
      var scoreCtl = tr
        ? '<span class="tb-score"><i class="fa-solid fa-trophy"></i>' +
            '<input type="number" class="tb-score-in" value="' + score + '" data-team="' + esc(tr.id) + '" aria-label="' + teamShort(L) + ' score">' +
            '<button class="tb-score-save" type="button" data-action="save-score" data-team="' + esc(tr.id) + '" title="Save score">Save</button></span>'
        : '<span class="tb-score tb-score-na" title="Assign members first"><i class="fa-solid fa-trophy"></i>—</span>';
      return '<div class="tb-card' + (full ? ' tb-full' : '') + (canFit ? ' tb-target' : '') + '">' +
        '<div class="tb-head"><h3>' + teamShort(L) + '</h3>' + scoreCtl + headExtra +
        '</div><div class="tb-slots">' + slots + '</div></div>';
    }).join('');

    // Each pool person: a checkbox+name that toggles selection, plus a "T?"
    // quick-assign. Opening "T?" keeps the checkbox and avatar exactly where
    // they are (checkbox just disabled) and swaps only the name for the six
    // team buttons — no left-jump. With 2+ selected use "Add Here" instead.
    var poolRows = pool.map(function (u) {
      var st = teamSlot(u);
      var sel = !!teamSel[u.id];
      var quick = teamQuick === u.id;
      var tDisabled = teamBusy || selCount > 1;
      // Checkbox + avatar render identically in both modes, so nothing shifts
      // when the popup opens.
      var check = '<span class="tb-check' + (sel ? ' on' : '') + (quick ? ' tb-check-off' : '') + '"' +
        (quick ? '' : ' data-action="tb-toggle-select" data-id="' + esc(u.id) + '"') +
        '><i class="fa-solid fa-check"></i></span>';
      var head = check + avatar(u, 'avatar-sm');
      var tail;
      if (teamBusyId === u.id) {
        // this person's assignment is in flight — freeze their row with a spinner
        tail = '<span class="tb-pname tb-prow-busy" title="Assigning…"><i class="fa-solid fa-spinner fa-spin"></i> Assigning…</span>';
      } else if (quick) {
        tail = '<div class="tb-quickrow">' + TEAM_LETTERS.map(function (L) {
          var isFull = counts[L][st] >= TEAM_CAP[st];
          return '<button type="button" class="tb-qletter" data-action="assign-team" data-id="' + esc(u.id) + '" data-team="' + L + '"' +
            ((isFull || teamBusy) ? ' disabled title="' + teamShort(L) + ' has no free ' + st + ' slot"' : ' title="Assign to ' + teamShort(L) + '"') + '>' + teamNum(L) + '</button>';
        }).join('') + '</div>' +
          '<button type="button" class="tb-qclose" data-action="tb-quick-close" title="Close"><i class="fa-solid fa-xmark"></i></button>';
      } else {
        tail = '<span class="tb-pname" data-action="tb-toggle-select" data-id="' + esc(u.id) + '" title="' + esc(u.name) + '">' + esc(u.name) + '</span>' +
          (st === 'mentor' ? '<span class="tb-tag">mentor</span>' : '') +
          '<button type="button" class="tb-qtoggle" data-action="tb-quick" data-id="' + esc(u.id) + '"' +
            (tDisabled ? ' disabled' : '') + ' title="Quick assign to a team">T?</button>';
      }
      return '<div class="tb-prow' + (sel ? ' selected' : '') + '">' +
        '<div class="tb-prow-row' + (quick ? ' tb-quickactive' : '') + '">' + head + tail + '</div></div>';
    }).join('');

    // No unassigned people → drop the left column entirely and let the six
    // team cards fill the full width (the original three-column view).
    if (!pool.length) {
      return '<div class="teamboard"><div class="tb-teams tb-teams-full">' + cards + '</div></div>';
    }

    // Master select: same checkbox as the rows — empty / star (some) /
    // check (all); click flips between select-all and select-none.
    var allSel = selCount > 0 && selCount === pool.length;
    var someSel = selCount > 0 && !allSel;
    var masterBox = '<span class="tb-check' + (allSel || someSel ? ' on' : '') + (someSel ? ' tb-some' : '') + '">' +
      (someSel ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-solid fa-check"></i>') + '</span>';
    var assignedCount = Object.keys(assigned).length;
    var assignable = users.filter(teamAssignable).length;
    return '<div class="teamboard"><div class="tb-layout">' +
      '<div class="tb-unassigned panel">' +
        '<div class="tb-uhead">' +
          '<button type="button" class="tb-masterbtn" data-action="tb-select-all-toggle"' +
            (teamBusy ? ' disabled' : '') + ' title="Select all / none">' + masterBox + '</button>' +
          '<h3><i class="fa-solid fa-user-plus"></i>Unassigned</h3>' +
          (teamBusy ? '<span class="tb-spin"><i class="fa-solid fa-spinner fa-spin"></i></span>' : '') +
          '<span class="tb-progress">' + assignedCount + ' / ' + assignable + '</span>' +
        '</div>' +
        '<div class="tb-pool">' + poolRows + '</div>' +
      '</div>' +
      '<div class="tb-teams">' + cards + '</div>' +
      '</div></div>';
  }

  // ---- Wallet push (admin broadcast to installed wallet cards) ----
  var walletPushHist = null; // null = not loaded yet; [] = loaded, empty

  function adminWalletSection(d) {
    if (walletPushHist === null) {
      A.api('wallet_push_history', {}).then(function (r) {
        walletPushHist = r.pushes || [];
        if (location.hash === '#/admin' && adminTab === 'wallet') route();
      }).catch(function () { walletPushHist = []; });
    }
    var loading = walletPushHist === null;
    var hist = walletPushHist || [];
    var histHtml = loading
      ? '<div class="skeleton" style="height:56px;margin-bottom:8px"></div><div class="skeleton" style="height:56px"></div>'
      : (hist.length
        ? hist.map(function (p) {
            var counts = (p.googleCount || p.appleCount)
              ? '<span class="wp-counts"><i class="fa-brands fa-google-wallet"></i>' + (p.googleCount || 0) +
                '<i class="fa-brands fa-apple"></i>' + (p.appleCount || 0) + '</span>' : '';
            return '<div class="wp-item"><div class="wp-msg">' + esc(p.message) + '</div>' +
              '<div class="wp-meta">' + esc(p.sentBy || '') + ' · ' + esc(timeAgo(p.sentAt)) + counts + '</div></div>';
          }).join('')
        : '<div class="empty" style="margin:0"><i class="fa-regular fa-paper-plane"></i>No broadcasts yet.</div>');
    return '<div class="wallet-admin">' +
      '<div class="panel wp-compose">' +
        '<h3><i class="fa-solid fa-bullhorn"></i>Send a wallet notification</h3>' +
        '<p class="wp-lead">Pushes to every member’s installed card (Google&nbsp;+&nbsp;Apple) and updates the card’s <b>LATEST</b> line. Logged in the history below.</p>' +
        '<textarea id="wpInput" class="wp-input" maxlength="200" rows="3" placeholder="e.g. Lunch is served in the atrium — sessions resume at 1:30"></textarea>' +
        '<div class="wp-actions"><span class="wp-hint">Shown on the card and as a push notification.</span>' +
          '<button class="btn btn-gradient btn-sm" data-action="wallet-push-send"><i class="fa-solid fa-paper-plane"></i><span class="label">Send push</span><span class="spin"></span></button>' +
        '</div>' +
      '</div>' +
      '<div class="panel wp-history"><h3><i class="fa-solid fa-clock-rotate-left"></i>History</h3>' + histHtml + '</div>' +
    '</div>';
  }

  // Which admin tab is showing; the last-used tab is remembered per project so
  // returning to Admin reopens the view you left.
  function adminTabKey() { return 'ice.admintab.' + A.getProject(); }
  var adminTab = 'people';
  try { var savedTab = localStorage.getItem(adminTabKey()); if (savedTab) adminTab = savedTab; } catch (e) { /* private mode */ }

  // Teams tab interaction state (module-level so it survives route() re-renders).
  var teamSel = {};        // userId -> true : multi-selected people in the pool
  var teamQuick = null;    // userId whose "T?" quick-assign popup is open
  var teamQuickTimer = null; // auto-closes the popup after 5 s
  var teamBusy = false;    // an assign request is in flight — freeze the board
  var teamBusyId = null;   // the single person being (re)assigned — shows a spinner on their card

  function viewAdmin() {
    var d = state.data;
    if (!d) return skeletons();
    if (!d.isAdmin) return '<div class="empty" style="margin-top:40px"><i class="fa-solid fa-shield-halved"></i>Admins only.</div>';
    var users = (d.users || []);
    var tabs = [{ id: 'people', label: 'People (' + users.length + ')' }];
    tabs.push({ id: 'teams', label: 'Teams' });
    tabs.push({ id: 'wallet', label: 'Wallet' });
    if (d.registryUrl) tabs.push({ id: 'projects', label: 'Platform' });
    tabs.push({ id: 'event', label: 'Event' });
    tabs.push({ id: 'resources', label: 'Resources' });
    if (!tabs.some(function (t) { return t.id === adminTab; })) adminTab = 'people';
    var bar = '<div class="admin-tabs">' + tabs.map(function (t) {
      return '<button class="comm-tab' + (t.id === adminTab ? ' active' : '') + '" type="button" data-action="admin-tab" data-tab="' + t.id + '">' + t.label + '</button>';
    }).join('') + '</div>';
    var body =
      adminTab === 'teams' ? adminTeamsSection(d) :
      adminTab === 'wallet' ? adminWalletSection(d) :
      adminTab === 'projects' ? projectsPanel(d) :
      adminTab === 'event' ? adminEventSection(d) :
      adminTab === 'resources' ? adminResourcesSection(d) :
      adminPeopleSection(d);
    // tabs sit at the footer, on the same line as the sidebar's Admin item
    return '<div class="admin-wrap"><div class="admin-tabview">' + body + '</div>' + bar + '</div>';
  }

  // ---------------------------------------------------------------- router

  var routes = [
    { re: /^#\/?$/, view: viewLanding },
    { re: /^#\/people$/, view: viewHome },
    { re: /^#\/profile\/([\w-]+)$/, view: viewProfile },
    // the teams listing is gone — People (with its team filter) covers it;
    // team detail pages remain reachable from profiles
    { re: /^#\/teams$/, view: function () { location.hash = '#/people'; return ''; } },
    { re: /^#\/team\/([\w-]+)$/, view: viewTeam },
    { re: /^#\/projects(?:\/(\d+))?$/, view: viewProjects },
    { re: /^#\/skills$/, view: viewSkills },
    { re: /^#\/program$/, view: viewProgram },
    { re: /^#\/tools$/, view: viewTools },
    { re: /^#\/about$/, view: viewAbout },
    { re: /^#\/announcements$/, view: viewAnnouncements },
    { re: /^#\/register$/, view: viewRegister },
    { re: /^#\/me$/, view: viewMe },
    { re: /^#\/wallet(?:\?.*)?$/, view: viewWallet },
    { re: /^#\/pcard(?:\?.*)?$/, view: viewProjectCard },
    { re: /^#\/admin$/, view: viewAdmin },
  ];

  function route() {
    var hash = location.hash || '#/';
    // The view is (re)built from the current payload — record its signature so
    // a following background refresh can tell whether anything structural
    // actually changed before deciding to repaint (see refresh()).
    state.renderedSig = dataSig(state.data);
    // #/wallet is phone-first — keep the .is-wallet flag in sync so its CSS
    // bypasses the mobile gate and shows only the handoff view.
    document.documentElement.classList.toggle('is-wallet', /^#\/(wallet|pcard)/.test(hash));
    closeMenu();
    // Stop a profile-backdrop video when navigating away (route() also re-runs on
    // in-place data refreshes — those keep the same hash, so playback survives).
    if (profileBg && hash !== profileBgHash) stopProfileBg();
    // Drop an open announcement draft when leaving the news page.
    if (annDraft.open && !/^#\/announcements$/.test(hash)) annDraft = { open: false, editing: null };
    // Leave inline team-edit mode when navigating away from that team.
    if (teamEditing && hash !== '#/team/' + teamEditing) teamEditing = null;
    var view = $('#view');
    // Security: a signed-in but un-invited account is held at a switch-account
    // gate for every route (except the tokenless phone wallet/pcard handoff) —
    // it must never reach People/Program/Tools or any members-only data.
    if (isLockedOut() && !/^#\/(wallet|pcard)/.test(hash)) {
      view.innerHTML = viewNotInvited();
      renderChrome();
      wireViewExtras(hash, null);
      return;
    }
    for (var i = 0; i < routes.length; i++) {
      var m = hash.match(routes[i].re);
      if (m) {
        // Data refreshes re-route — but rebuilding the landing would recreate
        // the iframe and restart the video (visible as a double fade-in).
        if (routes[i].view === viewLanding && view.querySelector('.landing')) {
          renderChrome();
          return;
        }
        view.innerHTML = routes[i].view(m[1]);
        renderChrome();
        wireViewExtras(hash, m);
        return;
      }
    }
    view.innerHTML = '<div class="empty" style="margin-top:40px"><i class="fa-regular fa-compass"></i>Page not found. <a href="#/">Go home</a></div>';
  }

  function wireViewExtras(hash, m) {
    // people wordmark: build tiles from live data, then scale to fit
    if ($('#word')) requestAnimationFrame(buildWordmark);
    // skills constellation
    var sc = $('#skillsCanvas');
    if (sc) initSkillsGraph(sc);
    // landing video: fade in on actual playback
    var fv = $('.feature-video');
    if (fv) initLandingVideo(fv);
    // profile page: auto-play the member's own clip as a full-screen backdrop
    // (skip a needless restart when a data refresh re-routes to the same profile)
    var pmatch = hash.match(/^#\/profile\/([\w-]+)$/);
    if (pmatch) {
      var pu = userById(pmatch[1]);
      var pvid = pu && pu.video;
      if (pvid) {
        if (!(profileBg && profileBgHash === hash)) playProfileBg(pvid);
        else setProfileBgMuteIcon(); // re-sync the header button after a repaint
      } else stopProfileBg();
      if (pu) initProfilePersona(pu);
    }
    // invite-only gate: submit the access code on Enter
    var acInput = $('#accessCodeInput');
    if (acInput) {
      acInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var b = $('[data-action="access-code-submit"]');
        if (b) b.click();
      });
    }
    // program: swap the skeleton for live calendar events when configured
    if ($('.program-grid')) initProgram();
    // tools: load the project/team resources
    if ($('#toolsView')) initTools();
    // wallet: profile QR panel + the phone's #/wallet handoff page
    if ($('#walletPanel')) initWalletPanel();
    if ($('#walletView')) initWalletHandoff();
    if ($('#pcardView')) initProjectCardHandoff();
    // projects: draw the QR on any card with a valid website
    if ($('#projectsGrid')) renderProjectCardQRs();
    // shared project deep-link (#/projects/<slot>): auto-open that project card
    var projDeep = hash.match(/^#\/projects\/(\d+)$/);
    if (projDeep && $('#projectsGrid') && projSel == null) {
      var dslot = Number(projDeep[1]);
      requestAnimationFrame(function () { if (projSel == null) openProject(dslot, false); });
    }
    // skill tag input
    var skillInput = $('#skillInput');
    if (skillInput) {
      skillInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addTag(skillInput.value.replace(/,$/, ''));
          skillInput.value = '';
        } else if (e.key === 'Backspace' && !skillInput.value) {
          var chips = $all('#skillTags [data-skill]');
          if (chips.length) { chips[chips.length - 1].remove(); refreshSkillsUI(); saveRegDraft(); updateJoinState(); schedulePersona(); }
        }
      });
    }
  }

  // -------------------------------------------------------------- actions

  async function pickImage(btn) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      busy(btn, true);
      try {
        var dataUrl = await downscale(file, 640, 0.85);
        var r = await A.api('upload_image', { data: dataUrl, filename: file.name.replace(/\.[^.]+$/, '') });
        var form = btn.closest('form');
        form.querySelector('[name="' + btn.getAttribute('data-target') + '"]').value = r.url;
        var prev = document.getElementById(btn.getAttribute('data-preview'));
        if (prev) { prev.src = r.url; prev.style.display = ''; }
        toast('Image uploaded');
      } catch (err) {
        toast(err.message || 'Upload failed', true);
      } finally {
        busy(btn, false);
      }
    };
    input.click();
  }

  function downscale(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }

  function collectProfile(form) {
    var fd = new FormData(form);
    // GitHub waiver: when the person typed the bypass keyword (no GitHub account)
    // store NO GitHub link — so nothing bogus shows on their card and the backend
    // never adds them to the org — and flag the waiver so the server accepts it.
    var ghRaw = String(fd.get('linkGithub') || '').trim();
    var ghWaiver = String(C.GITHUB_BYPASS || '');
    var ghBypassed = !!ghWaiver && ghRaw.toLowerCase() === ghWaiver.toLowerCase();
    var links = [
      ghBypassed ? '' : normUrl(completeLink('linkGithub', fd.get('linkGithub'))),
      normUrl(fd.get('linkWebsite')),
      normUrl(completeLink('linkLinkedin', fd.get('linkLinkedin'))),
    ].filter(Boolean);
    // the hidden `video` field holds the uploaded intro clip's Drive URL (or '')
    var video = fd.get('video') || '';
    var first = String(fd.get('firstName') || '').trim();
    var last = String(fd.get('lastName') || '').trim();
    return {
      // first/last recombine into the single stored display name; firstName &
      // lastName are also sent so the backend can mint firstname@designthinking.lk.
      name: (first + ' ' + last).trim(),
      firstName: first,
      lastName: last,
      image: fd.get('image'),
      affiliation: fd.get('affiliation'),
      gender: fd.get('gender'),
      bio: fd.get('bio'),
      skills: getTagValues(),
      links: links,
      video: video,
      videoName: video ? profileVideoName : '',
      // access-code bypass of the invite-only gate (ignored by update_profile)
      accessCode: storedAccessCode(),
      // GitHub-requirement waiver keyword (empty unless the person has no GitHub)
      githubBypass: ghBypassed ? ghWaiver : '',
      // no role: it's pre-assigned by the invite (register) and admin-managed
      // via the role chips (update_profile ignores it anyway)
    };
  }

  async function confirmModal(title, body, yesLabel) {
    return new Promise(function (resolve) {
      modal('<h2>' + esc(title) + '</h2><p style="color:var(--text-body)">' + esc(body) + '</p>' +
        '<div class="form-actions"><button class="btn btn-danger" id="confirmYes">' + esc(yesLabel || 'Delete') + '</button>' +
        '<button class="btn btn-ghost" data-action="close-modal">Cancel</button></div>');
      $('#confirmYes').onclick = function () { closeModal(); resolve(true); };
      $('#modalRoot .modal-backdrop').addEventListener('click', function () { resolve(false); }, { once: true });
    });
  }

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-action]');
    // Close the workshop switcher when clicking anywhere outside the brand.
    if (brandMenuOpen && !e.target.closest('#brand')) {
      brandMenuOpen = false; renderProjectSwitcher(state.data || {});
    }
    if (!t) return;
    var action = t.getAttribute('data-action');
    var id = t.getAttribute('data-id');

    switch (action) {
      case 'sign-in': A.signIn(); break;
      case 'access-code-submit': {
        var acInp = $('#accessCodeInput');
        var acCode = acInp ? String(acInp.value || '').trim() : '';
        var acWant = String(C.ACCESS_CODE || '');
        if (acCode && acWant && acCode.toLowerCase() === acWant.toLowerCase()) {
          try { sessionStorage.setItem(accessCodeKey(), acCode); } catch (e) { /* private mode */ }
          toast('Access granted — complete your card to join.');
          route(); // re-render #/register: the bypass now opens the form
        } else {
          toast('That access code isn’t right.', true);
          if (acInp) { acInp.focus(); acInp.select(); }
        }
        break;
      }
      case 'tool-filter':
        toolsUI.filter = t.getAttribute('data-f') || 'all';
        renderToolsBar(); renderToolsGrid();
        break;
      case 'tool-add-open': openToolForm(null); break;
      case 'tool-edit': openToolForm(toolById(t.getAttribute('data-id'))); break;
      case 'tool-cancel': closeToolForm(); break;
      case 'tool-copy': {
        var ct = toolById(t.getAttribute('data-id'));
        if (ct && ct.secret) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(ct.secret).then(function () { toast('Secret copied'); })
              .catch(function () { window.prompt('Copy this secret:', ct.secret); });
          } else window.prompt('Copy this secret:', ct.secret);
        }
        break;
      }
      case 'tool-del': toolsUI.deleting = t.getAttribute('data-id'); renderToolsGrid(); break;
      case 'tool-del-no': toolsUI.deleting = null; renderToolsGrid(); break;
      case 'tool-del-yes': {
        var delId = t.getAttribute('data-id');
        busy(t, true);
        try { await A.api('tool_delete', { id: delId }); toolsUI.deleting = null; await refreshTools(); toast('Tool removed'); }
        catch (err) { toast(err.message || 'Could not remove.', true); busy(t, false); }
        break;
      }
      case 'tool-save': {
        var tf = collectToolForm();
        if (!toolFormValid(tf)) break;
        var editingTool = toolsUI.form && toolsUI.form.editing;
        busy(t, true);
        try {
          if (editingTool) await A.api('tool_update', Object.assign({ id: editingTool.id }, tf));
          else await A.api('tool_add', tf);
          closeToolForm();
          await refreshTools();
          toast(editingTool ? 'Tool updated' : 'Tool added');
        } catch (err) { toast(err.message || 'Could not save.', true); busy(t, false); }
        break;
      }
      case 'card-share': {
        var shareUrl = shareCardUrl(t.getAttribute('data-kind'), t.getAttribute('data-id'));
        // Always copy the clean URL to the clipboard first (during the click
        // gesture) and toast it — some Safari share sheets omit a Copy action,
        // so this guarantees the link is always grabbable. Then offer the native
        // share sheet where available. We pass ONLY `url` (no `text`): putting the
        // URL in both fields made Safari's Copy paste it twice.
        copyShareLink(shareUrl);
        if (navigator.share) {
          navigator.share({ title: eventName(), url: shareUrl }).catch(function () {});
        }
        break;
      }
      case 'sign-out': e.preventDefault(); closeMenu(); A.signOut(); break;
      case 'user-menu': e.preventDefault(); openMenu('user'); break;
      case 'guest-menu': e.preventDefault(); openMenu('guest'); break;
      case 'menu-nav': closeMenu(); break; // let the anchor navigate
      case 'wallet-show': showWalletFlyout(); break;
      case 'wallet-hide': hideWalletFlyout(); break;
      case 'proj-open': {
        var pslot = Number(t.getAttribute('data-slot'));
        if (projSel == null) openProject(pslot, false);
        else if (pslot === projSel && !projEdit) flipStack(); // click the top card to deal it under
        break;
      }
      case 'proj-edit': e.preventDefault(); e.stopPropagation(); openProject(Number(t.getAttribute('data-slot')), true); break;
      case 'proj-edit-inline': startProjectEdit(projSel); renderProjectDetail(); break;
      case 'proj-edit-tab': {
        captureProjectDraft(); // keep in-flight edits before swapping tabs
        projEditTab = t.getAttribute('data-tab') || 'details';
        renderProjectDetail();
        break;
      }
      case 'proj-view-tab': {
        projViewTab = t.getAttribute('data-tab') || 'details';
        renderProjectDetail();
        break;
      }
      case 'proj-demo-fullscreen': {
        var dv = $('#projDemoVideo');
        if (dv) {
          if (dv.requestFullscreen) dv.requestFullscreen();
          else if (dv.webkitEnterFullscreen) dv.webkitEnterFullscreen(); // iOS Safari
          else if (dv.webkitRequestFullscreen) dv.webkitRequestFullscreen();
          var dp = dv.play && dv.play(); if (dp && dp.catch) dp.catch(function () {});
        }
        break;
      }
      case 'proj-remove-video': removeProjectVideo(Number(t.getAttribute('data-slot'))); break;
      case 'proj-color': {
        projEditColor = t.getAttribute('data-color');
        var fc = $('#projectsGrid .pc-front'); // live-preview on the stacked hero card
        if (fc) fc.className = fc.className.replace(/pc-[1-6]/, projEditColor);
        var sw = $('#projDetail') ? $('#projDetail').querySelectorAll('.proj-swatch') : [];
        Array.prototype.forEach.call(sw, function (s) { s.classList.toggle('on', s.getAttribute('data-color') === projEditColor); });
        updateProjSaveState(); // a colour change is an edit
        break;
      }
      case 'proj-cancel': projEdit = false; projEditColor = ''; renderProjectDetail(); break;
      case 'proj-upload-video': pickProjectVideo(Number(t.getAttribute('data-slot')), t); break;
      case 'proj-video-mute': {
        var pv = $('#projDetail video');
        if (pv) { pv.muted = !pv.muted; if (pv.muted) { /* keep it going */ } else { pv.play && pv.play(); }
          var pi = t.querySelector('i'); if (pi) pi.className = pv.muted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
          t.setAttribute('title', pv.muted ? 'Unmute' : 'Mute');
        }
        break;
      }
      case 'proj-save': saveProject(Number(t.getAttribute('data-slot')), t); break;
      case 'proj-close': closeProject(); break;
      case 'proj-nav': closeProject(); break; // let the profile link navigate
      case 'pcard-show': e.preventDefault(); e.stopPropagation(); showProjectCardWallet(Number(t.getAttribute('data-slot'))); break;
      case 'pcard-hide': e.preventDefault(); hideProjectCardWallet(); break;
      case 'close-modal': closeModal(); break;
      case 'filter-skill': {
        var s = t.getAttribute('data-skill');
        state.skillFilter = state.skillFilter === s ? null : s;
        if (!/^#\/people$/.test(location.hash || '#/')) location.hash = '#/people'; else route();
        break;
      }
      case 'filter-team': {
        var tid = t.getAttribute('data-team');
        var teamOn = state.teamFilter !== tid;
        state.teamFilter = teamOn ? tid : null;
        // Update in place (no rebuild) so the octagons don't flash.
        $all('#hiveTeams .team-chip').forEach(function (c) {
          c.classList.toggle('on', c.getAttribute('data-team') === state.teamFilter);
        });
        applyTeamFilter();
        var cap = $('.hive-caption');
        if (cap) {
          // Name comes from the chip so the caption works for the empty-state
          // scaffold too (those teams aren't in state.data.teams).
          var team = teamOn ? { name: t.getAttribute('data-name') } : null;
          cap.innerHTML = hiveCaptionText((state.data && state.data.users) || [], team);
        }
        break;
      }
      case 'toggle-chat': { if (!chatEnabled()) break; var cp = $('#chatpane'); if (cp) setChatPane(cp.hidden); break; }
      case 'comm-tab':
        commTab = t.getAttribute('data-tab') === 'broadcast' ? 'broadcast' : 'chat';
        if (commTab === 'chat' && chatUI.mode === 'convo') closeConvo();
        renderChatPane();
        break;
      case 'chat-connect': {
        busy(t, true);
        try { await chatConnect(); renderChatPane(); startUnreadPoll(); sweepUnread(); }
        catch (err) { renderChatPane(); }
        busy(t, false);
        break;
      }
      case 'chat-open-dm': openConvo(t.getAttribute('data-person')); break;
      case 'chat-back': closeConvo(); break;
      case 'chat-send': await sendChatMessage(t); break;
      case 'bcast-send': {
        var bi = $('#bcastInput');
        var msg = bi ? bi.value.trim() : '';
        if (!msg) break;
        busy(t, true);
        try {
          // announcements need a title — the first line doubles as one
          var firstLine = msg.split('\n')[0].slice(0, 80);
          await A.api('ann_create', { title: firstLine, content: msg, type: 'general', isPublished: true });
          if (bi) bi.value = '';
          await refresh();
          toast('Broadcast sent to everyone');
        } catch (err) { toast(err.message, true); }
        busy(t, false);
        renderChatPane();
        break;
      }
      case 'save-score': {
        var stid = t.getAttribute('data-team');
        var sin = document.querySelector('.tb-score-in[data-team="' + stid + '"]');
        var sval = sin ? sin.value : '';
        busy(t, true);
        try {
          var sr = await A.api('admin_set_score', { teamId: stid, score: sval });
          if (sr.team) {
            (state.data.teams || []).forEach(function (x, i) { if (x.id === stid) state.data.teams[i] = sr.team; });
            A.writeCache(state.data);
          }
          toast('Team score saved — cards refresh within ~5 min');
        } catch (err) { toast(err.message, true); }
        busy(t, false);
        break;
      }
      case 'wallet-push-send': {
        var wi = $('#wpInput');
        var wmsg = wi ? wi.value.trim() : '';
        if (!wmsg) { toast('Type a message first', true); break; }
        busy(t, true);
        try {
          var wr = await A.api('admin_wallet_push', { message: wmsg });
          if (wi) wi.value = '';
          walletPushHist = null; // force history reload on re-render
          route();
          toast('Pushed to wallets · Google ' + (wr.googleCount || 0) + ' · Apple ' + (wr.appleCount || 0));
        } catch (err) { toast(err.message, true); busy(t, false); }
        break;
      }
      case 'toggle-theme': {
        var dark = !isDark();
        try { localStorage.setItem('ice.theme', dark ? 'dark' : 'light'); } catch (err) { /* private mode */ }
        applyTheme(dark, true);
        break;
      }
      case 'toggle-mine': setMine(!mineOn()); break;
      case 'new-team': teamForm(); break;
      case 'edit-team':
        // Inline editing — flip the team view's fields into inputs (no popup).
        teamEditing = id;
        route();
        break;
      case 'team-edit-cancel':
        teamEditing = null;
        route();
        break;
      case 'team-edit-save': {
        var nameEl = $('.te-name'), descEl = $('.te-desc'), lookEl = $('.te-looking');
        var coverEl = $('#view input[name="coverImage"]');
        var name = nameEl ? String(nameEl.value || '').trim() : '';
        if (!name) { toast('Team name is required.', true); if (nameEl) nameEl.focus(); break; }
        busy(t, true);
        try {
          await A.api('update_team', {
            teamId: id, name: name,
            description: descEl ? descEl.value : '',
            lookingFor: lookEl ? lookEl.value : '',
            coverImage: coverEl ? coverEl.value : '',
          });
          teamEditing = null;
          delete teamDetailCache[id];
          await refresh();
          toast('Team updated');
        } catch (err) {
          toast(err.message || 'Could not save.', true);
          busy(t, false);
        }
        break;
      }
      case 'join-team':
      case 'leave-team':
        busy(t, true);
        try {
          await A.api(action === 'join-team' ? 'join_team' : 'leave_team', { teamId: id });
          delete teamDetailCache[id];
          await refresh();
          toast(action === 'join-team' ? 'Welcome to the team' : 'You left the team');
        } catch (err) { toast(err.message, true); busy(t, false); }
        break;
      case 'post-team': {
        var input = $('#postInput');
        var content = input && input.value.trim();
        if (!content) break;
        busy(t, true);
        try {
          await A.api('team_post_add', { teamId: id, content: content });
          delete teamDetailCache[id];
          route();
        } catch (err) { toast(err.message, true); busy(t, false); }
        break;
      }
      case 'add-link':
        modal('<h2>Add a link</h2><form class="form" id="linkForm" data-team="' + esc(id) + '">' +
          '<div class="field"><label>URL</label><input class="input" name="url" required placeholder="https://…"></div>' +
          '<div class="field"><label>Title</label><input class="input" name="title" maxlength="150"></div>' +
          '<div class="field"><label>Description <span class="hint">optional</span></label><input class="input" name="description" maxlength="500"></div>' +
          '<div class="form-actions"><button class="btn btn-gradient" type="submit"><span class="label">Add link</span><span class="spin"></span></button>' +
          '<button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button></div></form>');
        break;
      case 'del-link':
        try {
          await A.api('team_link_delete', { linkId: id });
          delete teamDetailCache[t.getAttribute('data-team')];
          route();
        } catch (err) { toast(err.message, true); }
        break;
      case 'chat-dm': {
        if (!chatEnabled()) break;   // messaging temporarily disabled
        // Open the in-site messaging pane on this person's conversation.
        var chatPerson = t.getAttribute('data-person');
        if (!chatPerson) { toast('This person has no workshop account yet.', true); break; }
        commTab = 'chat';
        setChatPane(true);
        openConvo(chatPerson);
        break;
      }
      case 'new-ann': openAnnDraft(null); break;
      case 'edit-ann': {
        var ann = null;
        (state.data.announcements || []).forEach(function (x) { if (x.id === id) ann = x; });
        openAnnDraft(ann);
        break;
      }
      case 'save-ann': { var af = $('#annForm'); if (af) submitAnn(af, false, t); break; }
      case 'discard-ann': annDraft = { open: false, editing: null }; route(); break;
      case 'del-ann':
        if (await confirmModal('Delete announcement?', 'This cannot be undone.')) {
          try { await A.api('ann_delete', { id: id }); toast('Deleted'); refresh(); }
          catch (err) { toast(err.message, true); }
        }
        break;
      case 'del-user': deletingUserId = id; route(); break; // open inline confirm strip
      case 'del-user-cancel': deletingUserId = null; route(); break;
      case 'del-user-confirm': {
        busy(t, true);
        // Lock the whole confirm strip while the delete runs — no cancelling mid-flight.
        var cancelBtn = t.closest('.row-confirm-actions');
        cancelBtn = cancelBtn && cancelBtn.querySelector('[data-action="del-user-cancel"]');
        if (cancelBtn) cancelBtn.disabled = true;
        try {
          await A.api('admin_delete_user', { userId: id });
          userProjects = null;
          await refresh();          // re-render with the row gone (keeps the spinner up until then)
          deletingUserId = null;
          toast('User removed');
        } catch (err) {
          toast(err.message, true); busy(t, false);
          if (cancelBtn) cancelBtn.disabled = false;
        }
        break;
      }
      case 'invite-open': {
        if (inviteCard && inviteCard.sending) break;
        var invRole = t.getAttribute('data-role');
        inviteCard = { role: (invRole === 'mentor' || invRole === 'catalyst' || invRole === 'admin') ? invRole : 'participant', chips: [] };
        route();
        var invEntry0 = $('#inviteEntry');
        if (invEntry0) invEntry0.focus();
        break;
      }
      case 'invite-cancel': {
        if (inviteCard && inviteCard.sending) break;
        inviteCard = null;
        route();
        break;
      }
      case 'invite-focus': { var invFoc = $('#inviteEntry'); if (invFoc) invFoc.focus(); break; }
      case 'invite-chip-x': {
        if (!inviteCard || inviteCard.sending) break;
        inviteCard.chips.splice(Number(t.getAttribute('data-idx')), 1);
        renderInviteCard();
        break;
      }
      case 'invite-send': {
        if (!inviteCard || inviteCard.sending) break;
        // absorb whatever is still sitting uncommitted in the input
        var invEntry = $('#inviteEntry');
        if (invEntry && invEntry.value.trim()) {
          var invLeft = inviteAbsorb(invEntry.value);
          if (invLeft.length) {
            renderInviteCard(invLeft.join(' '));
            toast('Not a valid email: ' + invLeft.join(', '), true);
            break;
          }
        }
        if (!inviteCard.chips.length) { renderInviteCard(); break; }
        // Freeze the composer while the batch is in flight — cancelling or
        // editing chips mid-request would misreport what was actually sent.
        inviteCard.sending = true;
        $all('.invite-card [data-action="invite-cancel"], .invite-card .chip-x, .invite-card #inviteEntry')
          .forEach(function (el) { el.disabled = true; });
        busy(t, true);
        try {
          var invRes = await A.api('admin_invite', { emails: inviteCard.chips, role: inviteCard.role });
          var invMsg = [];
          if (invRes.sent.length) invMsg.push(invRes.sent.length + ' invitation' + (invRes.sent.length === 1 ? '' : 's') + ' sent');
          if (invRes.alreadyRegistered.length) invMsg.push('already registered: ' + invRes.alreadyRegistered.join(', '));
          if (invRes.failed.length) invMsg.push('email failed: ' + invRes.failed.join(', '));
          inviteCard = null;
          await refresh();
          toast(invMsg.join(' · ') || 'Nothing to send', invRes.failed.length > 0);
        } catch (err) {
          toast(err.message, true);
          busy(t, false);
          if (inviteCard) {
            inviteCard.sending = false;
            renderInviteCard(); // thaw — chips are kept for a retry
          }
        }
        break;
      }
      case 'invite-resend': {
        busy(t, true);
        try {
          await A.api('admin_resend_invite', { inviteId: id });
          toast('Invitation re-sent to ' + t.getAttribute('data-email'));
        } catch (err) { toast(err.message, true); }
        busy(t, false);
        break;
      }
      case 'invite-revoke': {
        // No popup — revoking a pending invite is low-stakes and reversible
        // (just re-invite). One click, disabled while it runs.
        t.disabled = true;
        try { await A.api('admin_revoke_invite', { inviteId: id }); toast('Invitation revoked'); refresh(); }
        catch (err) { toast(err.message, true); t.disabled = false; }
        break;
      }
      case 'role-menu': if (roleBusy) break; roleMenuFor = roleMenuFor === id ? null : id; route(); break;
      case 'role-add': {
        if (roleBusy) break;
        roleBusy = { userId: id, role: t.getAttribute('data-role'), op: 'add' };
        roleMenuFor = null;
        route(); // instant spinner on the pending chip; all role controls freeze
        try {
          await A.api('admin_add_role', { userId: id, role: roleBusy.role });
          toast('Role added');
          await refresh(); // spinner holds until fresh data is in
        } catch (err) { toast(err.message, true); }
        roleBusy = null;
        route();
        break;
      }
      case 'role-remove': {
        if (roleBusy) break;
        var remRole = t.getAttribute('data-role');
        var remUser = userById(id);
        var remName = remUser ? remUser.name : 'this person';
        // removing the last chip = losing access — worth an explicit confirm
        if (remUser && rolesOf(remUser).length === 1) {
          var sure = await confirmModal('Remove ' + remName + '’s last role?',
            'They will lose access to the platform (visitor view only) until a role is assigned again. Nothing is deleted — re-adding a role brings everything back.',
            'Remove role');
          if (!sure) break;
        }
        roleBusy = { userId: id, role: remRole, op: 'remove' };
        roleMenuFor = null;
        route(); // instant spinner on the pending chip; all role controls freeze
        try {
          await A.api('admin_remove_role', { userId: id, role: remRole });
          toast('Role removed');
          await refresh(); // spinner holds until fresh data is in
        } catch (err) { toast(err.message, true); }
        roleBusy = null;
        route();
        break;
      }
      case 'pick-image': pickImage(t); break;
      case 'photo-pick': { var pf = $('#photoFile'); if (pf) pf.click(); break; }
      case 'flip-card': { var card = $('#idcard'); if (card) card.classList.toggle('flipped'); break; }
      case 'profile-video-pick': pickProfileVideo(); break;
      case 'profile-video-remove': removeProfileVideo(); break;
      case 'profile-video-play': playProfileBg(t.getAttribute('data-src')); break;
      case 'profile-bg-stop': stopProfileBg(); break;
      case 'profile-bg-mute': {
        var bv = $('#profileBgEl');
        if (bv) { bv.muted = !bv.muted; if (!bv.muted) { var bp = bv.play(); if (bp && bp.catch) bp.catch(function () {}); } setProfileBgMuteIcon(); }
        break;
      }
      case 'card-video-edit': openVideoOverlay(); break;
      case 'close-video': closeVideoOverlay(); break;
      case 'card-video-mute': {
        cardVideoMuted = !cardVideoMuted;
        cardUserMuted = cardVideoMuted; // explicit choice — suppresses auto-unmute
        var cv = $('#cardVideoEl');
        if (cv) {
          if (!cardVideoMuted) { playCardUnmuted(cv); }
          else { clearInterval(cv.__volTimer); cv.__volTimer = null; cv.muted = true; }
        }
        setCardMuteIcon();
        break;
      }
      case 'add-tag': addTag(t.getAttribute('data-skill')); break;
      case 'rm-tag': {
        e.preventDefault();
        // the clicked chip may be the picker's mirror copy — always remove
        // the canonical chip on the card; refreshSkillsUI resyncs the mirror
        var rmv = t.closest('[data-skill]').getAttribute('data-skill');
        $all('#skillTags [data-skill]').forEach(function (c) {
          if (c.getAttribute('data-skill') === rmv) c.remove();
        });
        refreshSkillsUI(); saveRegDraft(); updateJoinState(); schedulePersona();
        break;
      }
      case 'open-skills': openSkills(); break;
      case 'close-skills': closeSkills(); break;
      case 'add-typed-skill': { var si3 = $('#skillInput'); if (si3) { addTag(si3.value); si3.value = ''; si3.focus(); } break; }
      case 'brand-switch': e.preventDefault(); brandMenuOpen = !brandMenuOpen; renderProjectSwitcher(state.data || {}); break;
      case 'brand-pick': {
        e.preventDefault();
        var bp = t.getAttribute('data-proj');
        brandMenuOpen = false;
        if (bp === A.getProject()) { renderProjectSwitcher(state.data || {}); break; }
        switchProject(bp); // full redirect to the project's subdomain (production)
        break;
      }
      case 'proj-tab-list': showNewProject = false; route(); break;
      case 'proj-tab-new': showNewProject = true; route(); break;
      case 'cancel-new-project': showNewProject = false; route(); break;
      case 'switch-project-btn': switchProject(t.getAttribute('data-proj')); break;
      case 'admin-tab':
        adminTab = t.getAttribute('data-tab');
        try { localStorage.setItem(adminTabKey(), adminTab); } catch (e) { /* private mode */ }
        route();
        break;
      case 'tb-toggle-select': {
        if (teamBusy) break;
        if (teamSel[id]) delete teamSel[id]; else teamSel[id] = true;
        // With 2+ picked the "Add Here" flow takes over, so drop any open popup.
        if (Object.keys(teamSel).length > 1) { teamQuick = null; clearTimeout(teamQuickTimer); }
        route();
        break;
      }
      case 'tb-select-all-toggle': {
        if (teamBusy) break;
        var poolAll = unassignedPoolIds();
        var everyOn = poolAll.length && poolAll.every(function (pid) { return teamSel[pid]; });
        teamSel = {};
        if (!everyOn) poolAll.forEach(function (pid) { teamSel[pid] = true; });
        teamQuick = null; clearTimeout(teamQuickTimer);
        route();
        break;
      }
      case 'tb-quick': {
        if (teamBusy) break;
        teamQuick = (teamQuick === id) ? null : id;
        clearTimeout(teamQuickTimer);
        if (teamQuick) teamQuickTimer = setTimeout(function () { teamQuick = null; route(); }, 5000);
        route();
        break;
      }
      case 'tb-quick-close': { teamQuick = null; clearTimeout(teamQuickTimer); route(); break; }
      case 'tb-add-here': {
        var addTeam = t.getAttribute('data-team');
        var ids = Object.keys(teamSel);
        if (!ids.length) break;
        teamBusy = true; teamQuick = null; clearTimeout(teamQuickTimer); route();
        var okCount = 0, addErr = null;
        for (var qi = 0; qi < ids.length; qi++) {
          try {
            var r2 = await A.api('admin_assign_team', { userId: ids[qi], team: addTeam });
            if (r2.teams) { state.data.teams = r2.teams; A.writeCache(state.data); }
            delete teamSel[ids[qi]];
            okCount++;
          } catch (e2) { addErr = e2; }
        }
        teamBusy = false; route();
        if (okCount) toast(okCount + (okCount === 1 ? ' person' : ' people') + ' → Team ' + addTeam);
        if (addErr) toast(addErr.message, true);
        break;
      }
      case 'assign-team':
      case 'unassign-team': {
        var teamLetter = action === 'assign-team' ? t.getAttribute('data-team') : '';
        // Freeze the whole board (disables every button) and show the spinner
        // until the request settles — one assignment at a time.
        teamBusy = true; teamBusyId = id; teamQuick = null; clearTimeout(teamQuickTimer); route();
        try {
          var ar = await A.api('admin_assign_team', { userId: id, team: teamLetter });
          if (ar.teams) { state.data.teams = ar.teams; A.writeCache(state.data); }
          delete teamSel[id];
          teamBusy = false; teamBusyId = null; route();
          var au = userById(id);
          toast((au ? au.name : 'User') + (teamLetter ? ' → Team ' + teamLetter : ' unassigned'));
        } catch (err) {
          teamBusy = false; teamBusyId = null;
          toast(err.message, true);
          refresh(); // board may be stale (someone else assigned) — resync
        }
        break;
      }
      case 'save-dates': {
        var sd = $('#evStart') ? $('#evStart').value : '';
        var ed = $('#evEnd') ? $('#evEnd').value : '';
        if (sd && ed && ed < sd) { toast('End date is before the start date.', true); break; }
        busy(t, true);
        try {
          await A.api('admin_update_project', { startDate: sd, endDate: ed });
          toast('Event dates saved');
          await refresh();
        } catch (err) { toast(err.message, true); }
        busy(t, false);
        break;
      }
    }
  });

  // Close the avatar dropdown on an outside click or Escape.
  document.addEventListener('click', function (e) {
    var pop = $('#menuPop');
    if (!pop || pop.hidden) return;
    if (e.target.closest('#menuPop')) return;
    if (e.target.closest('[data-action="user-menu"],[data-action="guest-menu"]')) return;
    closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
    // Chat composer: Enter sends, Shift+Enter makes a newline.
    if (e.target && e.target.id === 'chatMsgInput' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var sendBtn = document.querySelector('[data-action="chat-send"]');
      sendChatMessage(sendBtn);
    }
  });

  // Auto-grow the chat composer as it wraps.
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'chatMsgInput') { chatUI.draft = e.target.value; autoGrow(e.target); }
  });

  document.addEventListener('change', async function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.getAttribute('data-action') === 'toggle-reg') {
      try {
        var r = await A.api('admin_set_config', { registrationOpen: t.checked });
        toast('Registration is now ' + (r.registrationOpen ? 'open' : 'closed'));
        adminProjects = null;
        refresh();
      } catch (err) { toast(err.message, true); }
    }
    // Inline project editors in the admin Projects panel — each row targets
    // its own project via an explicit `project` override.
    var pa = t.getAttribute('data-action');
    if (pa === 'proj-status' || pa === 'proj-reg' || pa === 'proj-prov') {
      var pid = t.getAttribute('data-proj');
      var patch = { project: pid };
      if (pa === 'proj-status') patch.status = t.value;
      if (pa === 'proj-reg') patch.registrationOpen = t.checked;
      if (pa === 'proj-prov') patch.provisionAccounts = t.checked;
      try {
        await A.api('admin_update_project', patch);
        adminProjects = null;
        toast('Project updated');
        refresh(); // projects list + current-project flags may have changed
      } catch (err) {
        toast(err.message, true);
        adminProjects = null;
        if (location.hash === '#/admin') route(); // revert the control
      }
    }
  });

  // Invite composer chip entry — delegated so composer re-renders keep working.
  // Enter/comma/semicolon/space commits the token; Backspace on an empty input
  // removes the last chip.
  document.addEventListener('keydown', function (e) {
    var input = e.target;
    if (!inviteCard || inviteCard.sending || !input || input.id !== 'inviteEntry') return;
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
      e.preventDefault();
      if (!input.value.trim()) return;
      var bad = inviteAbsorb(input.value);
      renderInviteCard(bad.join(' '));
      if (bad.length) toast('Not a valid email: ' + bad.join(', '), true);
    } else if (e.key === 'Backspace' && !input.value && inviteCard.chips.length) {
      inviteCard.chips.pop();
      renderInviteCard();
    } else {
      input.classList.remove('bad');
    }
  });

  document.addEventListener('paste', function (e) {
    var input = e.target;
    if (!inviteCard || inviteCard.sending || !input || input.id !== 'inviteEntry') return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text');
    var bad = inviteAbsorb(input.value + ' ' + text);
    renderInviteCard(bad.join(' '));
    if (bad.length) toast('Not a valid email: ' + bad.join(', '), true);
  });

  // Keep the half-typed address in state — see renderInviteCard.
  document.addEventListener('input', function (e) {
    if (inviteCard && e.target && e.target.id === 'inviteEntry') inviteCard.text = e.target.value;
  });

  document.addEventListener('submit', async function (e) {
    var form = e.target;
    // NOTE: use getAttribute('id'), NOT form.id — a form control with
    // name="id" (the New Project subdomain input) shadows the form's native
    // .id property, so form.id would return that <input>, not "projectForm".
    var formId = form.getAttribute('id');
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');

    if (formId === 'profileForm') {
      var status = $('#profileStatus');
      status.className = 'form-status';
      status.textContent = '';
      var invalid = validateProfile(form);
      if (invalid) { status.textContent = invalid; return; }
      busy(btn, true);
      var cardBusy = $('#cardBusy');
      if (cardBusy) cardBusy.hidden = false;
      try {
        // if the user picked a new photo, bake the cropped square & upload it
        if (photoEd) {
          var dataUrl = photoBake();
          var up = await A.api('upload_image', { data: dataUrl, filename: 'profile' });
          form.querySelector('[name="image"]').value = up.url;
        }
        var payload = collectProfile(form);
        var isNew = form.getAttribute('data-new') === '1';
        try {
          await A.api(isNew ? 'register' : 'update_profile', payload);
        } catch (err) {
          // A retried register can land twice: 'exists' means the first
          // attempt succeeded and only its response was lost — carry on.
          if (!(isNew && err.code === 'exists')) throw err;
        }
        if (isNew) clearRegDraft(); else clearEditDraft();
        photoEd = null;
        await refresh();
        toast(isNew ? 'Welcome aboard' : 'Profile saved');
        location.hash = '#/profile/' + (me() ? me().id : '');
      } catch (err) {
        status.textContent = err.message || 'Something went wrong.';
      } finally {
        busy(btn, false);
        var cb = $('#cardBusy');
        if (cb) cb.hidden = true;
      }
    }

    if (formId === 'teamForm') {
      busy(btn, true);
      var fd = new FormData(form);
      var teamId = form.getAttribute('data-id');
      var body = {
        name: fd.get('name'), description: fd.get('description'),
        lookingFor: fd.get('lookingFor'), coverImage: fd.get('coverImage'),
      };
      try {
        var r = teamId
          ? await A.api('update_team', Object.assign({ teamId: teamId }, body))
          : await A.api('create_team', body);
        closeModal();
        delete teamDetailCache[teamId || (r.team && r.team.id)];
        await refresh();
        location.hash = '#/team/' + r.team.id;
        toast(teamId ? 'Team updated' : 'Team created');
      } catch (err) {
        $('#teamFormStatus').textContent = err.message;
        busy(btn, false);
      }
    }

    if (formId === 'annForm') {
      // Submit = Send (publish). Save-draft goes through the save-ann action.
      submitAnn(form, true, btn);
    }

    if (formId === 'projectForm') {
      var fdp = new FormData(form);
      var newSlug = String(fdp.get('id') || '').trim().toLowerCase();
      // Guard: the Create button is already gated on these, but re-check on
      // submit — reject an invalid slug or one that's already registered.
      if (!validProjectId(newSlug)) {
        var st0 = $('#projectFormStatus'); if (st0) st0.textContent = 'Name must be 2–16 chars: lowercase letters, digits, hyphens.';
        return;
      }
      if (projectIdTaken(newSlug)) {
        var warnEl = $('#projIdWarn'); if (warnEl) warnEl.hidden = false;
        var inpEl = $('#projIdInput'); if (inpEl) inpEl.classList.add('input-invalid');
        var st = $('#projectFormStatus'); if (st) st.textContent = 'A project with that name already exists.';
        return;
      }
      // Whole flow wrapped so any throw (busy/route/api) surfaces as an error
      // toast + status rather than a swallowed unhandled rejection.
      try {
        busy(btn, true);
        setCreatingProject(newSlug);
        showNewProject = false;
        adminProjects = null;
        route();
        startProjectPolling();
        await A.api('admin_create_project', {
          id: newSlug,
          tagline: fdp.get('tagline'),
        });
        setCreatingProject(null);
        stopProjectPolling();
        adminProjects = null;
        route();
        refresh(); // pulls the new project into the switcher
        toast('Project “' + newSlug + '” is ready');
      } catch (err) {
        console.error('[ICE create] FAILED:', err, err && err.stack);
        setCreatingProject(null);
        stopProjectPolling();
        adminProjects = null;
        showNewProject = true;
        route();
        var msg = $('#projectFormStatus');
        if (msg) msg.textContent = (err && err.message) || 'Create failed';
        toast((err && err.message) || 'Create failed', true);
      }
    }

    if (formId === 'linkForm') {
      busy(btn, true);
      var fd3 = new FormData(form);
      var teamId3 = form.getAttribute('data-team');
      try {
        await A.api('team_link_add', {
          teamId: teamId3, url: fd3.get('url'), title: fd3.get('title'), description: fd3.get('description'),
        });
        closeModal();
        delete teamDetailCache[teamId3];
        route();
        toast('Link added');
      } catch (err) { toast(err.message, true); busy(btn, false); }
    }
  });

  // ------------------------------------------------------------------ boot

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', fitWordmark);

  // Ambient idle: after 15s with no pointer/key/scroll input, fade the
  // peripheral action buttons (team chips, We/Me, theme, profile menu, admin and
  // the About/Program/Tools fabs — see body.idle in app.css). Any activity
  // brings them straight back. Capture phase so scrolls inside inner panes count.
  var idleTimer = null;
  function wakeChrome() {
    if (document.body.classList.contains('idle')) document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 15000);
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, wakeChrome, { passive: true, capture: true });
  });
  wakeChrome();

  // Live "name already taken" check + Create-button gating on the New Project
  // field. Delegated (survives re-renders) and bound to input/keyup/change so a
  // typed, pasted, autofilled or browser-restored value all sync the button —
  // never leaving it stuck disabled with a valid value in the box. Uses the
  // already-fetched project list, no round-trip.
  function syncProjectForm(t) {
    if (!t || t.id !== 'projIdInput') return;
    var taken = projectIdTaken(t.value);
    var valid = validProjectId(t.value);
    var warn = $('#projIdWarn');
    if (warn) warn.hidden = !taken;
    t.classList.toggle('input-invalid', taken);
    // Enabled only when the name is a valid slug (2–16 chars) AND not taken.
    var btn = t.form && t.form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = !(valid && !taken);
  }
  ['input', 'keyup', 'change'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { syncProjectForm(e.target); });
  });

  (function boot() {
    // ?project=<slug> deep-links into a specific project (e.g. a next-year
    // invite link) — it becomes the sticky selection.
    try {
      var qp = new URLSearchParams(location.search).get('project');
      if (qp) A.setProject(qp.toLowerCase());
    } catch (e) { /* old browser */ }
    applyTheme(localStorage.getItem('ice.theme') === 'dark'); // sync the toggle icon
    // restore the persisted "Highlight mine" state (renderChrome hides the
    // button + clears the glow again if this visitor turns out not to be a member)
    if (localStorage.getItem(MINE_KEY) === '1') document.body.classList.add('mine-on');
    if (creatingProject()) startProjectPolling(); // resume a create that was in flight before a refresh
    var justSignedIn = A.absorbLoginToken();
    state.data = A.readCache();
    renderChrome();
    route();
    refresh({ background: true }).then(function () {
      if (justSignedIn && signedIn() && state.data && !state.data.me) {
        location.hash = '#/register';
      }
    });
    // Keep presence dots + broadcasts fresh (and mark ourselves online)
    // while the tab is visible. 2 min < the backend's 5-min online window.
    // Background mode: refreshes data + chrome but never re-renders a busy view
    // (open project stack, playing video, unsaved edit).
    setInterval(function () {
      if (document.visibilityState !== 'visible' || !signedIn()) return;
      refresh({ background: true });
    }, 120000);
  })();
})();
