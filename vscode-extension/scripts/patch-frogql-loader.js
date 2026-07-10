#!/usr/bin/env node
/*
 * Patch the napi-rs generated frogql loader.
 *
 * The generated `isMusl()` does `process.report.getReport().header`, which is
 * undefined in the VS Code extension host on Linux, so activation crashes with
 * "Cannot read properties of undefined (reading 'header')". This rewrites the
 * else-branch to be null-safe and to default to glibc (which is what our shipped
 * linux-*-gnu binaries need). Idempotent: running twice is a no-op.
 *
 * Usage: node patch-frogql-loader.js path/to/frogql/index.js
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node patch-frogql-loader.js <frogql/index.js>');
  process.exit(2);
}

let s = fs.readFileSync(file, 'utf8');

const marker = 'report && report.header ? report.header.glibcVersionRuntime';
if (s.includes(marker)) {
  console.log('already patched: ' + file);
  process.exit(0);
}

const buggy = `  } else {
    const { glibcVersionRuntime } = process.report.getReport().header
    return !glibcVersionRuntime
  }`;

const fixed = `  } else {
    let report = null
    try { report = process.report.getReport() } catch (e) {}
    const glibcVersionRuntime = report && report.header ? report.header.glibcVersionRuntime : undefined
    if (glibcVersionRuntime) return false
    try {
      const lddPath = require('child_process').execSync('which ldd').toString().trim()
      return readFileSync(lddPath, 'utf8').includes('musl')
    } catch (e) {
      return false
    }
  }`;

if (!s.includes(buggy)) {
  console.error('pattern not found (loader shape changed?): ' + file);
  process.exit(1);
}

fs.writeFileSync(file, s.replace(buggy, fixed));
console.log('patched: ' + file);
