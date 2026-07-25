# ICE — Central Web (`ice-central-web`)

Static frontend for the ICE workshop platform, served via GitHub Pages.
Custom domain: `ice2026.designthinking.lk` today; moving to
`ice.designthinking.lk` (see the domain-cutover notes below).

**Multi-project:** one deployment serves every workshop instance (ice2026,
ice2027, test projects…). The active project is picked in the sidebar
dropdown (persisted in `localStorage` as `ice.project`, deep-linkable with
`?project=<slug>`); per-project branding and config come from the backend's
central registry sheet via `bootstrap`.

- No framework, no build step: `index.html` + vanilla JS hash-router.
- Design tokens from the [AHLab brand kit](https://cdn.ahlab.org/) (`css/theme.css`).
- Icons: Font Awesome Free. Fonts: Neue Haas Grotesk (Adobe Fonts) with system fallbacks.
- Backend: Google Apps Script (see the `ice-central-api` repo). Endpoints configured in `js/config.js`.

## Local development

```bash
python3 -m http.server 4870
# open http://localhost:4870
```

Sign-in works from localhost too (the auth broker allows `http://localhost:*` redirects).

## Domain cutover (pending)

1. Add DNS: `ice.designthinking.lk` CNAME → `designthinking-lk.github.io`.
2. Change `CNAME` in this repo to `ice.designthinking.lk`, set the custom
   domain in the repo's Pages settings, re-enable HTTPS enforcement.
3. Point `ice2026.designthinking.lk` at a redirect (separate tiny Pages repo
   or a DNS/proxy-level redirect), then remove its prefix from the auth
   broker's `ALLOWED_REDIRECT_PREFIXES`.
