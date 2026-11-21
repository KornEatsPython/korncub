// Copies data/*.json into Firestore collection "live" so the site reads fresh data without a Netlify deploy.
// Each doc is {json: "<stringified file>", updatedAt}. Runs from .github/workflows/sync-data.yml.
import admin from "firebase-admin";
import fs from "node:fs";
import path from "node:path";

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) { console.log("FIREBASE_SERVICE_ACCOUNT secret isn't set; skipping."); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
const db = admin.firestore();
const dir = path.resolve("..", "data");
let n = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
  const name = f.slice(0, -5);
  const text = JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  if (Buffer.byteLength(text) > 900000) { console.log(`${name}: too large for one doc, skipped`); continue; }
  await db.collection("live").doc(name).set({ json: text, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log(`${name}: ${Buffer.byteLength(text)} bytes`); n++;
}
console.log(`Synced ${n} docs.`);
