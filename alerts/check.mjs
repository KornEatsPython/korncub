// KornCub big-move alerts.
// Two kinds of alerts go to every phone that turned alerts on in the app:
//   Scoops:   reported Cubs deals from MLB Trade Rumors' Cubs feed (where Passan, Rosenthal and other
//             insider reports land within minutes). Deals only: signings, agreements, trades, extensions.
//   Official: big moves once MLB logs them in its official Cubs transactions.
// The same move usually alerts twice: once when it's reported, again when it's official.
// Runs on GitHub Actions every 15 minutes (kicked by cron-job.org).
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

// Scoops: MLB Trade Rumors' Cubs feed. A post counts when its headline reports a Cubs deal.
const SCOOP_FEED = "https://www.mlbtraderumors.com/chicago-cubs/feed";
const SCOOP_DEAL = /\b(to sign|sign|signs|signing|agree|agrees|agreed|agreement|acquire|acquires|acquiring|trade|trades|traded|extension|extend|extends|re-sign|re-signs)\b/i;
const SCOOP_SKIP = /minor league|minor-league|minors deal|non-tender|interest|interested|latest|rumou?rs|notes|links|chat|mailbag|poll|mock|offseason outlook|reportedly visited|showing|in talks|discussed|discussing|could|might|exploring|checked in|meet with|met with|candidates|targets?\b|options|pursuing|pursuit|connected|among teams|unlikely|won't|not expected|retire/i;
const SCOOP_MAX_AGE = 48 * 3600 * 1000; // never alert on a post older than two days

function decode(x) {
  return (x || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

export function isScoop(title) {
  return /cubs/i.test(title) && SCOOP_DEAL.test(title) && !SCOOP_SKIP.test(title);
}

export function parseFeed(xml) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(([item]) => {
    const link = tag(item, "link").split("?")[0];
    const guid = tag(item, "guid") || link;
    const id = (guid.match(/[?&]p=(\d+)/) || [])[1] || guid;
    return { id: `mlbtr-${id}`, title: tag(item, "title"), link, date: new Date(tag(item, "pubDate")) };
  });
}

async function scoops() {
  const r = await fetch(SCOOP_FEED, { headers: { "User-Agent": "korncub-alerts/1.0 (+https://korncub.netlify.app/)" } });
  if (!r.ok) throw new Error(`MLBTR feed ${r.status}`);
  const now = Date.now();
  return parseFeed(await r.text())
    .filter((s) => s.title && isScoop(s.title) && !(now - s.date > SCOOP_MAX_AGE))
    .sort((a, b) => a.date - b.date);
}

function scoopMessage(s) {
  return { title: "Cubs scoop (reported)", body: s.title, url: s.link || SITE, tag: s.id };
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
    title: `Cubs official: ${BIG[t.typeCode]}`,
    body: t.description,
    url: SITE,
    tag: `tx-${t.id}`,
  };
}

async function main() {
  const moves = await transactions();
  // A broken MLBTR feed must never stop official alerts.
  let reported = [];
  try {
    reported = await scoops();
  } catch (e) {
    console.log("Scoop feed unavailable:", e.message);
  }
  if (DRY) {
    console.log(`DRY RUN: ${reported.length} scoop headlines in the last 48h match:`);
    for (const s of reported) console.log(" -", s.date.toISOString(), JSON.stringify(scoopMessage(s)));
  }
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

  // Scoops keep their own memory. The first time scoops run, today's headlines are remembered, not sent.
  const scoopRef = db.doc("meta/scoops");
  const scoopState = (await scoopRef.get()).data() || {};
  const scoopSeen = new Set((scoopState.seen || []).map(String));
  if (!scoopState.seeded) {
    console.log(`Seeding scoops with ${reported.length} existing headlines; no scoop alerts sent.`);
    if (!DRY) await scoopRef.set({ seeded: true, seen: reported.map((s) => s.id).slice(-300), updated: new Date().toISOString() });
    reported = [];
  }

  const fresh = moves.filter((t) => !seen.has(String(t.id)));
  const freshScoops = reported.filter((s) => !scoopSeen.has(s.id));
  console.log(`${moves.length} big moves in window, ${fresh.length} new. ${reported.length} scoops in window, ${freshScoops.length} new.`);
  if (!fresh.length && !freshScoops.length) return;

  webpush.setVapidDetails("mailto:kalex6391@gmail.com", keys.publicKey, keys.privateKey);
  const subs = (await db.collection("pushSubs").get()).docs;
  console.log(`${subs.length} subscribed devices.`);

  async function send(msg) {
    const payload = JSON.stringify(msg);
    console.log("ALERT", payload);
    if (DRY) return;
    await Promise.all(
      subs.map(async (doc) => {
        const s = doc.data();
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 6 * 3600 });
        } catch (e) {
          // 404/410: the phone dropped the subscription. Clean it up.
          if (e.statusCode === 404 || e.statusCode === 410) await doc.ref.delete().catch(() => {});
          else console.log("push failed", doc.id, e.statusCode || e.message);
        }
      })
    );
  }

  for (const s of freshScoops) {
    await send(scoopMessage(s));
    scoopSeen.add(s.id);
  }
  for (const t of fresh) {
    await send(message(t));
    seen.add(String(t.id));
  }
  if (!DRY) {
    if (freshScoops.length) await scoopRef.set({ seeded: true, seen: [...scoopSeen].slice(-300), updated: new Date().toISOString() });
    if (fresh.length) await stateRef.set({ seeded: true, seen: [...seen].slice(-300), updated: new Date().toISOString() });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
