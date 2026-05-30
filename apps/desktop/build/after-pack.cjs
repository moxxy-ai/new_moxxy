// Ad-hoc code-sign the macOS .app before it's wrapped into the DMG.
//
// Builds here are unsigned (no Developer ID — see CSC_IDENTITY_AUTO_DISCOVERY
// in release-desktop.yml). On Apple Silicon a quarantined app with NO
// signature at all is reported as "is damaged and can't be opened" — a state
// the user cannot clear from the UI. An ad-hoc signature (`codesign -s -`)
// downgrades that to the normal "unverified developer" prompt, which users
// CAN bypass (right-click → Open, or System Settings → Privacy & Security →
// Open Anyway).
//
// This is not a substitute for real signing: a clean install with no prompt
// requires a Developer ID certificate + notarization (provide CSC_LINK /
// CSC_KEY_PASSWORD / APPLE_ID* secrets and drop CSC_IDENTITY_AUTO_DISCOVERY).
//
// electron-builder runs afterPack after the app is packed but before the DMG
// target is built, so the DMG ends up containing the signed app.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // When a real Developer ID cert is present (CSC_LINK set), electron-builder
  // does the proper hardened-runtime signing + notarization — ad-hoc signing
  // here would clobber it. Only ad-hoc sign the unsigned fallback build.
  if (process.env.CSC_LINK) {
    console.log('afterPack: Developer ID signing active (CSC_LINK set) — skipping ad-hoc signing');
    return;
  }

  const appBundle = fs.readdirSync(context.appOutDir).find((e) => e.endsWith('.app'));
  if (!appBundle) {
    console.warn(`afterPack: no .app found in ${context.appOutDir}; skipping ad-hoc signing`);
    return;
  }

  const appPath = path.join(context.appOutDir, appBundle);
  console.log(`afterPack: ad-hoc signing ${appPath}`);
  // --deep so the nested Electron frameworks / helpers are signed too.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
