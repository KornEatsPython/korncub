// KornCub big-move alerts.
// Reads MLB's official Cubs transactions, keeps the big ones, and sends a web push
// to every phone that turned alerts on in the app. Runs on GitHub Actions every 15 minutes.
//
// Secrets (GitHub → Settings → Secrets and variables → Actions):
//   FIREBASE_SERVICE_ACCOUNT  the Firebase service-account JSON (the only secret)
// The push key pair is made on the first run and kept in Firestore: the private half in meta/vapid
// (server only), the public half in public/push (the app reads it to subscribe).
//
// DRY_RUN=1 prints what it would send and changes nothing.

import admin from "firebase-admin";
import webpush from "web-push";

const TEAM = 112;
const SITE = "https://korncub.netlify.app/";
const DRY = process.env.DRY_RUN === "1";

// Which official moves count as "big".
const BIG = {
  TR: "Trade",
  CLW: "Waiver claim",
  DES: "Designated for assignment",
  REL: "Released",
  DFA: "Left as a free agent",
  SFA: "Signing",
  SGN: "Signing",
};

function isBig(t) {
  if (!BIG[t.typeCode]) return false;
  const d = (t.description || "").toLowerCase();
  if ((t.typeCode === "SFA" || t.typeCode === "SGN") && d.includes("minor league")) return false;
  return true;
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function transactions() {
  const end = new Date(Date.now() + 86400000);
  const start = new Date(Date.now() - 14 * 86400000);
  const url = `https://statsapi.mlb.com/api/v1/transactions?teamId=${TEAM}&startDate=${ymd(start)}&endDate=${ymd(end)}`;
  const r = await fetch(url, { headers: { "User-Agent": "korncub-alerts/1.0" } });
  if (!r.ok) throw new Error(`MLB API ${r.status}`);
  const all = (await r.json()).transactions || [];
  const byId = new Map();
  for (const t of all) if (isBig(t) && !byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id - b.id);
}

function message(t) {
  return {
    title: `Cubs: ${BIG[t.typeCode]}`,
    body: t.description,
    url: SITE,
    tag: `tx-${t.id}`,
  };
}

async function main() {
  const moves = await transactions();
  if (DRY && !process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log(`DRY RUN (no Firebase): ${moves.length} big moves in the last 14 days`);
    for (const t of moves) console.log(" -", t.date, JSON.stringify(message(t)));
    return;
  }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  // Push keys: create once, then reuse.
  const keyRef = db.doc("meta/vapid");
  let keys = (await keyRef.get()).data();
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    if (!DRY) {
      await keyRef.set(keys);
      await db.doc("public/push").set({ publicKey: keys.publicKey });
    }
    console.log("Created push keys.");
  }

  const stateRef = db.doc("meta/alerts");
  const state = (await stateRef.get()).data() || {};
  const seen = new Set((state.seen || []).map(String));

  // First run: remember what's already happened, alert nothing.
  if (!state.seeded) {
    const ids = moves.map((t) => String(t.id));
    console.log(`Seeding with ${ids.length} existing moves; no alerts sent.`);
    if (!DRY) await stateRef.set({ seeded: true, seen: ids.slice(-300), updated: new Date().toISOString() });
    return;
  }

  const fresh = moves.filter((t) => !seen.has(String(t.id)));
  console.log(`${moves.length} big moves in window, ${fresh.length} new.`);
  if (!fresh.length) return;

  webpush.setVapidDetails("mailto:kalex6391@gmail.com", keys.publicKey, keys.privateKey);
  const subs = (await db.collection("pushSubs").get()).docs;
  console.log(`${subs.length} subscribed devices.`);

  for (const t of fresh) {
    const payload = JSON.stringify(message(t));
    console.log("ALERT", payload);
    if (DRY) continue;
    await Promise.all(
      subs.map(async (doc) => {
        const s = doc.data();
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600 });
        } catch (e) {
          // 404/410: the phone dropped the subscription. Clean it up.
          if (e.statusCode === 404 || e.statusCode === 410) await doc.ref.delete();
          else console.log("push failed", doc.id, e.statusCode || e.message);
        }
      })
    );
    seen.add(String(t.id));
  }
  if (!DRY) await stateRef.set({ seeded: true, seen: [...seen].slice(-300), updated: new Date().toISOString() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
