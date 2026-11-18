const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
    index: true
  },
  player: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
    required: true,
    index: true
  },
  map: { type: String },
  agent: { type: String },
  kills: { type: Number },
  deaths: { type: Number },
  assists: { type: Number },
  score: { type: Number }, // ACS
  damage: {
    made: { type: Number },
    received: { type: Number }
  },
  acs: { type: Number },
  shots: {
    head: { type: Number },
    body: { type: Number },
    leg: { type: Number }
  },
  ability_cast_pr: {
    c_cast: { type: Number },
    q_cast: { type: Number },
    e_cast: { type: Number },
    x_cast: { type: Number }
  },
  afk_rounds: { type: Number },
  economy: {
    spent: { type: Number },
    loadout_value: { type: Number }
  },
  headshotPct: { type: Number },
  matchOutcome: { type: String }, // won, lost, tied
  tier: { type: String }, // Rank tier string
  playedAt: { type: Date },
  rounds: [{
    winning_team: String,
    end_type: String,
    bomb_planted: Boolean,
    bomb_defused: Boolean,
    player_stats: {
      kills: Number,
      score: Number,
      damage: Number,
      weapon: {
        id: String,
        name: String
      },
      economy: {
        loadout_value: Number,
        spent: Number,
        remaining: Number
      },
      was_afk: Boolean,
      stayed_in_spawn: Boolean
    }
  }],
  kill_events: [{
    kill_time_in_round: Number,
    kill_time_in_match: Number,
    killer_display_name: String,
    killer_team: String,
    victim_display_name: String,
    victim_team: String,
    victim_tier: String,
    victim_death_location: {
      x: Number,
      y: Number
    },
    damage_weapon_name: String,
    player_locations_on_kill: [{
      player_display_name: String,
      player_team: String,
      location: {
        x: Number,
        y: Number
      },
      view_radians: Number
    }]
  }]
}, {
  timestamps: true,
  // Keep the full normalized v4 match (all_players, PUUIDs, plant events, queue...): fields the schema
  // doesn't list were silently dropped before, leaving matches with no peers, roles or plant times.
  strict: false
});
matchSchema.index({ matchId: 1, player: 1 }, { unique: true });

module.exports = mongoose.model('Match', matchSchema);
