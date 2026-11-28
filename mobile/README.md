# Canvas Guardian Mobile-1 — Demo
S07 / CG-MOBILE-1-IMPLEMENT-001 (#31). Fixture-only Android UI; contract: [accepted CORE-1](https://github.com/Syris-EkzD/Canvas-Guardian/blob/729c0b849507fcd1a38e1fa4cb7605317d674035/docs/core-api-v1.md), [S05 design](https://github.com/Syris-EkzD/Canvas-Guardian/issues/29#issuecomment-7219666841). No real network, credentials, external link launch, persistence, settings mutations, AI, archive or push.

## S09 reproducible local QA
Expo SDK 57.0.34, RN 0.86.3, React 19.2.3, Router 57.0.32 selected from official sdk-57 template/bundledNativeModules.json. Router companion modules and system UI for Android theme; TypeScript/Expo ESLint only. Node 22.13+ (prefer Node 24). Provisional dev package dev.whitetree.guardiandemo, not release identity.
S07 registry DNS EAI_AGAIN; no lockfile invented. Candidate remains incomplete until actual mobile/package-lock.json is generated, reviewed and committed on this branch with coordinator approval. Check clean checkout and exact HEAD, then:
~~~sh
cd mobile
node -v
npm -v
npm install
npx expo install --check
npx expo-doctor
npm run typecheck
npm run lint
npm test
npm ci
npm run typecheck
npm run lint
npm test
~~~
Review any dependency fixes; no root installs or CI edits. Install Android Studio SDK API 36, JDK 17, platform-tools, emulator/KVM per Expo SDK 57 local setup docs on authorized workstation; verify SDK requirements and adb devices. Start emulator, run npm run android from mobile (npm start if Metro not running). Physical USB device: adb devices, npx expo run:android --device. No EAS/cloud build/signing/release. Record exact SHA, commands, exit codes, device/OS/build and screenshots. Inspect generated Android permissions and bundle/config for secrets and unexpected providers; development tooling may use local network, fixture transport must not. Unit checks do not prove native behavior; run component tests separately once suitable harness approved/available.

## Manual matrix
- Home Today=2, Pending=6 independently; status runtime unverified. Open each count into Planner; verify expected IDs pending 103,102,101,105,106,104; today 102,101; week 101,105; saved 107,108. Same-title distinct IDs, long/undated/null URL and local status not submitted. Activity summary, Settings, Android Back.
- Settings > Demo test controls: paging → Pending refresh → Load more twice; six distinct rows. conflict → next page → restart at zero, total five; conflict-twice → retryable failure. duplicate → rejection; empty → true zero; cached → server cached label.
- Reset demo, load complete view; upstream/offline/invalid → refresh → visibly stale prior complete data, not zero. status-error → independent failure; activity reads still work. rate-limit → retry blocked for three seconds. unauthenticated/forbidden/account-unverified/account-mismatch → all protected data hidden, reset demo only. slow → switch view/scenario during request; no cross-view/late publication.
- Observe 48dp targets, TalkBack names/roles/focus, system dark/light, rotation, background/foreground, large text, contrast, scroll and safe areas. No native pass without actual evidence. Check all data screens Demo-labeled, no future inactive tabs or live actions.
- Inspect exact diff for mobile/ only; root CI covers backend, not mobile acceptance. Stop for coordinator review.
