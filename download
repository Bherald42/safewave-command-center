# Safewave Command Center

Mobile-first internal ops platform for Safewave Technology — one place for team
communication, engineering triage, Shopify orders & finance, inventory + QC,
enterprise CRM, and compliance.

**Current state:** interactive prototype (v1.x) in `public/index.html`, wired with
live-data snapshots from the Safewave Shopify store. `SPEC.md` is the full build
specification.

## Run it locally (or in Codespaces)

Open in a GitHub Codespace (green **Code** button → Codespaces → Create) — the
container preinstalls Node 20 and `firebase-tools` automatically. Then:

```bash
# preview locally
npx serve public
# or with firebase's emulator
firebase serve
```

## Deploy to Firebase Hosting

One-time setup:

```bash
firebase login --no-localhost        # in Codespaces, follow the auth URL flow
```

Create a project (or reuse your existing Safewave Firebase project) at
https://console.firebase.google.com, then put its project ID in `.firebaserc`
(replace `YOUR-FIREBASE-PROJECT-ID`).

Deploy:

```bash
firebase deploy --only hosting
```

You'll get a live URL like `https://<project-id>.web.app` — installable on
phones as a PWA-style bookmark, shareable with the whole team.

## Roadmap (see SPEC.md for detail)

1. **Now:** static prototype on Firebase Hosting (this repo)
2. **Next:** backend functions that mirror Shopify (orders, inventory) into
   Firestore on a schedule + webhooks — never expose API tokens client-side
3. **Then:** Firebase Auth with Admin / Manager / Employee roles enforced by
   Firestore security rules; real data replaces the demo layers module by module
4. GitHub sync → engineering triage engine → ticketing → CRM → compliance

## Repo layout

```
public/index.html    the app (single file for now)
SPEC.md              full product & build specification
firebase.json        Firebase Hosting config
.firebaserc          Firebase project binding (edit me)
.devcontainer/       Codespaces environment (Node 20 + firebase-tools)
```
