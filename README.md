# The KornCub

A Chicago Cubs fan hub that installs on your phone like an app.

- `index.html`: the whole app.
- `data/*.json`: news, takes, depth chart and stat cards, refreshed by a scheduled Claude task.
- Live scores, standings and the 40-man roster load straight from MLB's free stats API.
- The Bleachers message board runs on Firebase (`firebase-config.js`, `firestore.rules`).
- Hosted on Netlify; every push to `main` republishes the site.

To install: open the site on your phone, then Share → Add to Home Screen (iPhone, Safari) or ⋮ → Install app (Android, Chrome).
