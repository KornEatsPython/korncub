# The KornCub

A Chicago Cubs fan hub that installs on your phone like an app.

- `index.html`: the whole app.
- `data/*.json`: news, takes, depth chart and stat cards, refreshed by a scheduled Claude task. A GitHub Action (`sync-data.yml`) copies them to Firestore (`live`), which is where the site reads them; Netlify skips data-only pushes. The Korn Column (`column/posts.json`) is synced and read the same way, so posting a column costs no deploy.
- Live scores, standings and the 40-man roster load straight from MLB's free stats API.
- The Bleachers message board runs on Firebase (`firebase-config.js`, `firestore.rules`).
- Hosted on Netlify; every push to `main` republishes the site.

To install: open the site on your phone, then Share → Add to Home Screen (iPhone, Safari) or ⋮ → Install app (Android, Chrome).

## Big-move alerts

Opt-in push notifications. The "Big-move alerts" switch in the app saves the phone's push subscription to Firestore (`pushSubs`). Every 15 minutes, `.github/workflows/alerts.yml` runs `alerts/check.mjs`, which reads MLB's official Cubs transactions and pushes trades, MLB signings, waiver claims, DFAs, releases and departures to every subscribed phone. It needs one repository secret, `FIREBASE_SERVICE_ACCOUNT` (the Firebase service-account JSON). The push keys are created on the first run and stored in Firestore. On iPhone, alerts only work once KornCub is added to the Home Screen.
