'use strict';

/*
 * Native loader for @openclaw/envelope-native.
 *
 * In a fully built install, `napi build` (or `napi prepublish -t npm`) writes
 * a platform-specific `openclaw-envelope.<triple>.node` next to this file and
 * a matching require() block here. We ship a hand-written equivalent so the
 * package still loads cleanly when the binary has not been built — in that
 * case `require('./...')` throws synchronously and the JS loader
 * (`src/signed-bus/lib/envelope-loader.js`) catches it and falls back to the
 * pure-JS envelope implementation.
 */

const { existsSync } = require('fs');
const { platform, arch } = process;
const { join } = require('path');

function tryRequire(localPath, sidecarPkg) {
  // Prefer the colocated .node (the result of `napi build --platform` on
  // this exact crate). Fall back to the sidecar npm shell package, which is
  // how a published @openclaw/envelope-native picks the per-triple prebuilt.
  const colocated = join(__dirname, localPath);
  if (existsSync(colocated)) {
    return require(colocated);
  }
  return require(sidecarPkg);
}

let native = null;

if (platform === 'win32' && arch === 'x64') {
  native = tryRequire('openclaw-envelope.win32-x64-msvc.node', '@openclaw/envelope-native-win32-x64');
} else if (platform === 'darwin' && arch === 'arm64') {
  native = tryRequire('openclaw-envelope.darwin-arm64.node', '@openclaw/envelope-native-darwin-arm64');
} else if (platform === 'linux' && arch === 'x64') {
  native = tryRequire('openclaw-envelope.linux-x64-gnu.node', '@openclaw/envelope-native-linux-x64');
} else {
  throw new Error(`@openclaw/envelope-native: no prebuilt for ${platform}-${arch}; build locally with \`cd crates/openclaw-envelope-node && npm install && npm run build\``);
}

module.exports = native;
module.exports.canonicalize = native.canonicalize;
module.exports.stable = native.stable;
module.exports.sign = native.sign;
module.exports.verify = native.verify;
