import os
import numpy as np

try:
    import onnxruntime as ort
    HAS_ORT = True
except ImportError:
    HAS_ORT = False

class SequenceAnalyzer:
    """
    Production inference engine for ValoSequenceTransformer.
    Uses onnxruntime for ultra-fast, zero-GPU CPU inference (< 5ms).
    Falls back gracefully if the neural model is not yet compiled.
    """
    def __init__(self, model_path=None):
        if model_path is None:
            # Default to data/valo_transformer.onnx relative to the ml directory
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            candidate = os.path.join(base_dir, "data", "valo_transformer.onnx")
            self.model_path = candidate if os.path.exists(candidate) else "data/valo_transformer.onnx"
        else:
            if not os.path.exists(model_path):
                base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
                alt = os.path.join(base_dir, model_path)
                self.model_path = alt if os.path.exists(alt) else model_path
            else:
                self.model_path = model_path

        self.session = None

        if HAS_ORT and os.path.exists(self.model_path):
            try:
                # Optimized single-thread or dual-thread CPU execution
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 2
                self.session = ort.InferenceSession(self.model_path, opts, providers=["CPUExecutionProvider"])
                print(f"SequenceAnalyzer: Successfully loaded neural model from {self.model_path}")
            except Exception as e:
                print(f"SequenceAnalyzer Warning: Failed to load ONNX model: {e}")
        else:
            if not os.path.exists(self.model_path):
                print(f"SequenceAnalyzer: Neural model {self.model_path} not found. Running in baseline sequence mode.")

    def format_match_to_tensor(self, match_rounds, player_puuid=None, player_riot_id=None):
        """
        Converts MongoDB match rounds array into [1, 24, 14] sequence tensor.
        """
        seq = np.zeros((1, 24, 14), dtype=np.float32)
        mask = np.zeros((1, 24), dtype=bool)

        rounds_len = min(len(match_rounds), 24)
        if rounds_len == 0:
            return seq, mask

        team_score = 0
        enemy_score = 0
        streak = 0

        for idx in range(rounds_len):
            r = match_rounds[idx]
            r_num = idx + 1

            p_stats = r.get("player_stats") or {}
            eco = p_stats.get("economy") or {}
            loadout = float(eco.get("loadout_value") or 0.0)
            remaining = float(eco.get("remaining") or 0.0)

            # Determine round outcome
            # winning_team can be 'Red' or 'Blue'
            won = 1.0 if r.get("winning_team") == p_stats.get("team") else 0.0

            seq[0, idx, 0] = r_num / 24.0
            seq[0, idx, 1] = min(loadout / 35000.0, 1.0)
            seq[0, idx, 2] = min(remaining / 35000.0, 1.0)
            seq[0, idx, 3] = 0.5 # estimated enemy loadout
            seq[0, idx, 4] = 0.5
            seq[0, idx, 5] = (loadout - 20000.0) / 35000.0
            seq[0, idx, 6] = (team_score - enemy_score) / 12.0
            seq[0, idx, 7] = team_score / 13.0
            seq[0, idx, 8] = enemy_score / 13.0
            seq[0, idx, 9] = max(-5.0, min(5.0, float(streak))) / 5.0
            seq[0, idx, 10] = 1.0 if loadout < 8000 else 0.0
            seq[0, idx, 11] = 1.0 if 8000 <= loadout < 20000 else 0.0
            seq[0, idx, 12] = 1.0 if loadout >= 20000 else 0.0
            seq[0, idx, 13] = 1.0 if r_num <= 12 else 0.0

            mask[0, idx] = True

            if won == 1.0:
                team_score += 1
                streak = (streak + 1) if streak > 0 else 1
            else:
                enemy_score += 1
                streak = (streak - 1) if streak < 0 else -1

        return seq, mask

    def analyze(self, match_rounds, player_puuid=None, player_riot_id=None):
        """
        Executes sequence inference. Returns round win probability curve,
        detected tilt/choke inflection point, and playstyle vector.
        """
        seq, mask = self.format_match_to_tensor(match_rounds, player_puuid, player_riot_id)
        active_rounds = int(mask.sum())

        if active_rounds == 0:
            return {
                "active_rounds": 0,
                "tilt_inflection_round": None,
                "win_probability_curve": [],
                "model_status": "insufficient_data"
            }

        # If ONNX neural model is available:
        if self.session is not None:
            try:
                inputs = {
                    "round_sequence": seq,
                    "round_mask": mask
                }
                outputs = self.session.run(None, inputs)
                round_win_logits = outputs[0][0] # [24]
                reconstructed = outputs[1][0]    # [24, 14]

                # Sigmoid win probabilities
                win_probs = (1.0 / (1.0 + np.exp(-round_win_logits[:active_rounds]))).tolist()

                # Anomaly Reconstruction Loss per round
                recon_errors = np.mean((reconstructed[:active_rounds] - seq[0, :active_rounds]) ** 2, axis=-1)
                tilt_round = int(np.argmax(recon_errors)) + 1

                return {
                    "active_rounds": active_rounds,
                    "tilt_inflection_round": tilt_round,
                    "tilt_anomaly_score": float(np.max(recon_errors)),
                    "win_probability_curve": [round(float(p), 3) for p in win_probs],
                    "model_status": "neural_onnx_active"
                }
            except Exception as e:
                print(f"ONNX inference failed: {e}")

        # Baseline analytical calculation (fallback when ONNX model is still training)
        win_probs = []
        team_score = 0
        enemy_score = 0
        for i in range(active_rounds):
            r = match_rounds[i]
            # Simple momentum heuristic
            score_delta = team_score - enemy_score
            prob = 0.5 + (score_delta * 0.04)
            win_probs.append(round(float(max(0.1, min(0.9, prob))), 3))
            
            p_stats = r.get("player_stats") or {}
            if r.get("winning_team") == p_stats.get("team"):
                team_score += 1
            else:
                enemy_score += 1

        return {
            "active_rounds": active_rounds,
            "tilt_inflection_round": max(1, active_rounds // 2),
            "tilt_anomaly_score": 0.15,
            "win_probability_curve": win_probs,
            "model_status": "baseline_active"
        }
