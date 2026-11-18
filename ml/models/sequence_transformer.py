"""
ValoSequenceTransformer
------------------------
A PyTorch Transformer architecture for round-by-round Valorant match telemetry.
Captures temporal momentum, economic cascading, and tilt/choke inflection points.
"""

import math

# Try importing torch; if not present locally (e.g. on lightweight server),
# this file serves as the architecture reference for Kaggle/Colab training.
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

if HAS_TORCH:
    class ValoSequenceTransformer(nn.Module):
        def __init__(
            self,
            input_dim=14,
            hidden_dim=128,
            num_heads=4,
            num_layers=3,
            dropout=0.1,
            max_rounds=24
        ):
            super().__init__()
            self.input_dim = input_dim
            self.hidden_dim = hidden_dim
            self.max_rounds = max_rounds

            # 1. Linear Input Projection + LayerNorm
            self.input_proj = nn.Sequential(
                nn.Linear(input_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Dropout(dropout)
            )

            # 2. Learnable Positional Encoding for rounds 1 to 24
            self.pos_embedding = nn.Parameter(torch.randn(1, max_rounds, hidden_dim) * 0.02)

            # 3. Bidirectional Transformer Encoder Stack
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=hidden_dim,
                nhead=num_heads,
                dim_feedforward=hidden_dim * 2,
                dropout=dropout,
                batch_first=True,
                activation="gelu"
            )
            self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)

            # 4. Multi-Task Output Heads
            # Head A: Round Win Probability (Per-round logit)
            self.round_win_head = nn.Sequential(
                nn.Linear(hidden_dim, 64),
                nn.GELU(),
                nn.Linear(64, 1)
            )

            # Head B: Reconstruction / Tilt-Anomaly Head (Reconstruct input round state)
            self.reconstruct_head = nn.Sequential(
                nn.Linear(hidden_dim, 64),
                nn.GELU(),
                nn.Linear(64, input_dim)
            )

            # Head C: Match Winner Head (Pooled match representation)
            self.match_win_head = nn.Sequential(
                nn.Linear(hidden_dim, 64),
                nn.GELU(),
                nn.Linear(64, 1)
            )

            # Head D: Continuous 16-D Tactical Playstyle Archetype
            self.archetype_head = nn.Linear(hidden_dim, 16)

        def forward(self, x, mask=None):
            """
            Args:
                x: Tensor of shape [Batch, 24, 14]
                mask: BoolTensor of shape [Batch, 24], True for active rounds, False for padding
            Returns:
                dict containing round_win_logits, reconstructed, match_win_logit, archetype_embedding
            """
            B, T, D = x.shape
            h = self.input_proj(x) + self.pos_embedding[:, :T, :]

            # In PyTorch TransformerEncoder, padding mask is True for PADDED elements
            padding_mask = ~mask if mask is not None else None

            encoded = self.transformer(h, src_key_padding_mask=padding_mask)

            # Predictions
            round_win_logits = self.round_win_head(encoded).squeeze(-1) # [B, 24]
            reconstructed = self.reconstruct_head(encoded)             # [B, 24, 14]

            # Masked Mean Pooling across active rounds
            if mask is not None:
                mask_expanded = mask.unsqueeze(-1).float()
                pooled = (encoded * mask_expanded).sum(dim=1) / mask_expanded.sum(dim=1).clamp(min=1.0)
            else:
                pooled = encoded.mean(dim=1)

            match_win_logit = self.match_win_head(pooled).squeeze(-1)   # [B]
            archetype_embedding = self.archetype_head(pooled)           # [B, 16]

            return {
                "round_win_logits": round_win_logits,
                "reconstructed": reconstructed,
                "match_win_logit": match_win_logit,
                "archetype_embedding": archetype_embedding
            }
else:
    class ValoSequenceTransformer:
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "PyTorch is not installed in the local runtime. "
                "Train the model using train_valo_transformer.ipynb on Kaggle/Colab, "
                "and deploy using onnxruntime via sequence_analyzer.py."
            )
