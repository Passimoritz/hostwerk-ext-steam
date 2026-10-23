'use strict';
/*
 * Steams Textformat KeyValues („VDF“) – libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf, loginusers.vdf,
 * registry.vdf (Linux). Aufbau:  "Schlüssel" "Wert"  bzw.  "Schlüssel" { … }.
 *
 * Nur lesen, nie schreiben: Hostwerk verändert keine Datei von Steam. Der Leser ist bewusst nachsichtig – Steam schreibt
 * gelegentlich Schlüssel ohne Anführungszeichen, Kommentare (//) und Bedingungen ([$WIN32]); doppelte Schlüssel behalten
 * den ersten Wert. Groß/klein ist in Steams Dateien nicht einheitlich („Apps“/„apps“) – dafür gibt es get().
 */

/** Text → verschachteltes Objekt (Werte sind immer Zeichenketten). Wirft nie: kaputte Dateien liefern, was lesbar war. */
function parse(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const root = {};
  const stack = [root];
  let i = 0;
  const n = s.length;
  let pendingKey = null;

  const readQuoted = () => {
    i++; // "
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === '\\' && i + 1 < n) {
        const e = s[i + 1];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '"' ? '"' : `\\${e}`;
        i += 2;
        continue;
      }
      if (c === '"') { i++; return out; }
      out += c;
      i++;
    }
    return out;
  };
  const readBare = () => {
    let out = '';
    while (i < n && !/[\s{}"]/.test(s[i])) out += s[i++];
    return out;
  };

  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '[') { while (i < n && s[i] !== ']' && s[i] !== '\n') i++; i++; continue; } // [$WIN32] – Bedingungen ignorieren
    const top = stack[stack.length - 1];
    if (c === '{') {
      i++;
      const obj = {};
      if (pendingKey !== null) { if (!Object.prototype.hasOwnProperty.call(top, pendingKey)) top[pendingKey] = obj; pendingKey = null; }
      stack.push(obj);
      continue;
    }
    if (c === '}') { i++; pendingKey = null; if (stack.length > 1) stack.pop(); continue; }
    const tok = c === '"' ? readQuoted() : readBare();
    if (tok === '' && c !== '"') { i++; continue; }
    if (pendingKey === null) pendingKey = tok;
    else {
      if (!Object.prototype.hasOwnProperty.call(top, pendingKey)) top[pendingKey] = tok;
      pendingKey = null;
    }
  }
  return root;
}

/** Wert unter einem Pfad, ohne Rücksicht auf Groß/klein: get(o, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'). */
function get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(cur, k)) { cur = cur[k]; continue; }
    const lk = String(k).toLowerCase();
    const hit = Object.keys(cur).find((x) => x.toLowerCase() === lk);
    cur = hit === undefined ? undefined : cur[hit];
  }
  return cur;
}

/** Zahl aus einem VDF-Wert (Zeichenkette) – sonst def. */
function num(v, def = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
}

module.exports = { parse, get, num };
