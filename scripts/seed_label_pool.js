#!/usr/bin/env node
/**
 * Adds a list of Riot accounts (e.g. the AP leaderboard snowball in ml/data) to the label-pool crawler frontier (local data/label_pool, never committed).
 * Lines look like "Name#TAG" or "Name#TAG#region". The crawler picks them up while someone is labeling.
 * Usage: node scripts/seed_label_pool.js ml/data/unprocessed_players.txt [source=leaderboard]
 */
const fs = require('fs');
const path = require('path');
const labelPool = require(path.resolve(__dirname, '../backend/src/services/labelPoolService'));

const [file, source = 'leaderboard'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/seed_label_pool.js <players.txt> [source]');
  process.exit(1);
}
const entries = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
  const parts = line.split('#');
  return parts.length >= 3
    ? { riotId: `${parts.slice(0, -2).join('#')}#${parts.at(-2)}`, region: parts.at(-1).toLowerCase() }
    : { riotId: line, region: undefined };
}).filter(e => /^[^#]{1,32}#[^#]{1,8}$/.test(e.riotId));

const added = labelPool.addAccounts(entries, source);
console.log(`Parsed ${entries.length} accounts, added ${added} new to the crawl frontier as "${source}".`);
