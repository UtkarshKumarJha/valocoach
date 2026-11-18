import os
import glob
import time
import json
import numpy as np
import pandas as pd

FEATURE_NAMES = [
    "round_num_norm",      # 0: r / 24.0
    "team_loadout_norm",   # 1: loadout / 35000.0
    "team_remaining_norm", # 2: remaining / 35000.0
    "enemy_loadout_norm",  # 3: enemy loadout / 35000.0
    "enemy_remaining_norm",# 4: enemy remaining / 35000.0
    "loadout_diff_norm",   # 5: (team_loadout - enemy_loadout) / 35000.0
    "score_diff",          # 6: (team_score - enemy_score) / 12.0
    "team_score_norm",     # 7: team_score / 13.0
    "enemy_score_norm",    # 8: enemy_score / 13.0
    "streak_norm",         # 9: clamped streak / 5.0
    "is_eco",              # 10: 1.0 if Eco buy tier, 0.0 otherwise
    "is_semi",             # 11: 1.0 if Semi buy tier, 0.0 otherwise
    "is_full",             # 12: 1.0 if Full buy tier, 0.0 otherwise
    "side_defense"         # 13: 1.0 for rounds 1-12, 0.0 for rounds 13-24
]

def parse_val(col):
    """Vectorized credit parser converting '3.9k', '24k', etc. to float credits."""
    return (
        col.astype(str)
        .str.lower()
        .str.replace("k", "", regex=False)
        .str.strip()
        .pipe(pd.to_numeric, errors="coerce")
        .fillna(0.0)
        * 1000.0
    )

def extract_match_sequences():
    print("=" * 60)
    print("VALOCOACH ML - VCT 24-ROUND SEQUENCE EXTRACTOR")
    print("=" * 60)

    eco_files = sorted(glob.glob("datasets/vct_*/matches/eco_rounds.csv"))
    if not eco_files:
        raise FileNotFoundError("No eco_rounds.csv files found under datasets/vct_*/matches/")

    print(f"Scanning {len(eco_files)} VCT tournament datasets (2021 - 2026)...")
    t0 = time.time()

    dfs = []
    for f in eco_files:
        try:
            df = pd.read_csv(f)
            dfs.append(df)
        except Exception as e:
            print(f"Warning: Failed to read {f}: {e}")

    combined = pd.concat(dfs, ignore_index=True)
    print(f"Combined {len(combined):,} round rows in {time.time() - t0:.2f}s.")

    # Vectorized Preprocessing
    print("Vectorizing financial and round outcome metrics...")
    combined["loadout"] = parse_val(combined["Loadout Value"])
    combined["remaining"] = parse_val(combined["Remaining Credits"])
    combined["is_win"] = (combined["Outcome"].astype(str).str.strip().str.lower() == "win").astype(float)
    
    type_str = combined["Type"].astype(str).str.lower()
    combined["is_eco"] = type_str.str.contains("eco").astype(float)
    combined["is_semi"] = type_str.str.contains("semi").astype(float)
    combined["is_full"] = type_str.str.contains("full").astype(float)

    # Deduplicate round events per match map
    combined = combined.drop_duplicates(subset=["Match Name", "Map", "Team", "Round Number"])
    combined = combined[(combined["Round Number"] >= 1) & (combined["Round Number"] <= 24)]

    sequences_X = []
    sequences_y_round = []
    sequences_y_match = []
    masks = []

    print("Constructing 24-round dual-perspective sequence tensors...")
    t1 = time.time()
    
    match_map_groups = combined.groupby(["Match Name", "Map"])
    total_groups = match_map_groups.ngroups
    print(f"Processing {total_groups:,} unique match maps...")

    for (m_name, map_name), group in match_map_groups:
        teams = group["Team"].unique()
        if len(teams) != 2:
            continue
            
        tA, tB = teams[0], teams[1]
        rounds_A = group[group["Team"] == tA].sort_values("Round Number").set_index("Round Number")
        rounds_B = group[group["Team"] == tB].sort_values("Round Number").set_index("Round Number")

        common_rounds = sorted(list(set(rounds_A.index).intersection(set(rounds_B.index))))
        if len(common_rounds) < 13: # Exclude forfeits or incomplete matches
            continue

        # Extract for both team perspectives
        for team, other_team, df_team, df_other in [(tA, tB, rounds_A, rounds_B), (tB, tA, rounds_B, rounds_A)]:
            seq = np.zeros((24, 14), dtype=np.float32)
            y_round = np.zeros(24, dtype=np.float32)
            mask = np.zeros(24, dtype=bool)

            team_score = 0
            enemy_score = 0
            streak = 0

            for r in common_rounds:
                idx = r - 1
                if idx >= 24:
                    break

                row_t = df_team.loc[r]
                row_o = df_other.loc[r]

                # 14 Engineered Normalized Features
                seq[idx, 0] = r / 24.0
                seq[idx, 1] = min(float(row_t["loadout"]) / 35000.0, 1.0)
                seq[idx, 2] = min(float(row_t["remaining"]) / 35000.0, 1.0)
                seq[idx, 3] = min(float(row_o["loadout"]) / 35000.0, 1.0)
                seq[idx, 4] = min(float(row_o["remaining"]) / 35000.0, 1.0)
                seq[idx, 5] = (float(row_t["loadout"]) - float(row_o["loadout"])) / 35000.0
                seq[idx, 6] = (team_score - enemy_score) / 12.0
                seq[idx, 7] = team_score / 13.0
                seq[idx, 8] = enemy_score / 13.0
                seq[idx, 9] = max(-5.0, min(5.0, float(streak))) / 5.0
                seq[idx, 10] = float(row_t["is_eco"])
                seq[idx, 11] = float(row_t["is_semi"])
                seq[idx, 12] = float(row_t["is_full"])
                seq[idx, 13] = 1.0 if r <= 12 else 0.0

                won = float(row_t["is_win"])
                y_round[idx] = won
                mask[idx] = True

                # Update live game momentum for subsequent rounds
                if won == 1.0:
                    team_score += 1
                    streak = (streak + 1) if streak > 0 else 1
                else:
                    enemy_score += 1
                    streak = (streak - 1) if streak < 0 else -1

            match_winner = 1.0 if team_score > enemy_score else 0.0

            sequences_X.append(seq)
            sequences_y_round.append(y_round)
            sequences_y_match.append(match_winner)
            masks.append(mask)

    X_arr = np.array(sequences_X, dtype=np.float32)
    y_round_arr = np.array(sequences_y_round, dtype=np.float32)
    y_match_arr = np.array(sequences_y_match, dtype=np.float32)
    mask_arr = np.array(masks, dtype=bool)

    print(f"Sequence construction complete in {time.time() - t1:.2f}s.")
    print("=" * 60)
    print("EXTRACTED DATASET SUMMARY:")
    print(f"  • Total Complete Sequences: {len(X_arr):,}")
    print(f"  • Sequence Tensor Shape:    {X_arr.shape}  (Batches, 24 Rounds, 14 Features)")
    print(f"  • Round Target Shape:       {y_round_arr.shape}")
    print(f"  • Match Winner Target:      {y_match_arr.shape} (Team Win Rate: {y_match_arr.mean()*100:.1f}%)")
    print(f"  • Active Valid Rounds:      {mask_arr.sum():,} rounds")
    print("=" * 60)

    # Save to ml/data/
    os.makedirs("data", exist_ok=True)
    out_npz = "data/round_sequences.npz"
    print(f"Compressing and saving to {out_npz}...")
    np.savez_compressed(
        out_npz,
        X=X_arr,
        y_round=y_round_arr,
        y_match=y_match_arr,
        mask=mask_arr
    )
    print(f"Saved! File size: {os.path.getsize(out_npz) / (1024 * 1024):.2f} MB")

    meta = {
        "num_sequences": len(X_arr),
        "sequence_length": 24,
        "num_features": 14,
        "feature_names": FEATURE_NAMES,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_active_rounds": int(mask_arr.sum())
    }
    with open("data/sequences_meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print("Metadata saved to data/sequences_meta.json.")

if __name__ == "__main__":
    extract_match_sequences()
