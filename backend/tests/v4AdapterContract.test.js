const fs = require('fs');
const path = require('path');
const { normalizeV4Match, validateNormalizedMatch } = require('../src/adapters/v4PayloadAdapter');

describe('Henrik v4 Match Adapter Contract Tests', () => {
  const v4RawPath = path.join(__dirname, 'fixtures', 'v4_raw_contract_fixture.json');
  const match1Path = path.join(__dirname, 'fixtures', 'match1.json');

  let rawV4;
  let match1Fixture;

  beforeAll(() => {
    rawV4 = JSON.parse(fs.readFileSync(v4RawPath, 'utf8'));
    match1Fixture = JSON.parse(fs.readFileSync(match1Path, 'utf8'));
  });

  test('successfully normalizes real raw Henrik v4 payload to internal schema', () => {
    const normalized = normalizeV4Match(rawV4, 'puuid_anon_0001');
    expect(normalized).toBeDefined();
    expect(normalized.matchId).toBe(rawV4.metadata.match_id);
    expect(normalized.map).toBe(rawV4.metadata.map.name);
    expect(normalized.all_players.length).toBe(10);
    expect(normalized.rounds.length).toBe(rawV4.rounds.length);
    expect(normalized.kill_events.length).toBe(rawV4.kills.length);

    const validation = validateNormalizedMatch(normalized);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test('normalized v4 output has identical top-level shape to existing fixtures', () => {
    const normalized = normalizeV4Match(rawV4, 'puuid_anon_0001');
    const fixtureKeys = Object.keys(match1Fixture).sort();
    const normalizedKeys = Object.keys(normalized).sort();

    // Verify all primary fixture keys exist on normalized v4 match
    for (const key of fixtureKeys) {
      expect(normalizedKeys).toContain(key);
    }
  });

  test('normalizes kill event structure and embeds player locations correctly', () => {
    const normalized = normalizeV4Match(rawV4, 'puuid_anon_0001');
    const firstKill = normalized.kill_events[0];

    expect(firstKill).toHaveProperty('round');
    expect(firstKill).toHaveProperty('kill_time_in_round');
    expect(firstKill).toHaveProperty('killer_puuid');
    expect(firstKill).toHaveProperty('victim_puuid');
    expect(firstKill).toHaveProperty('victim_death_location');
    expect(firstKill).toHaveProperty('player_locations_on_kill');
    expect(Array.isArray(firstKill.player_locations_on_kill)).toBe(true);
  });

  test('throws descriptive error on malformed raw payload', () => {
    expect(() => normalizeV4Match({})).toThrow(/missing metadata/);
    expect(() => normalizeV4Match(null)).toThrow(/missing metadata/);
  });
});
