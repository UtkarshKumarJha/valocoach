#!/usr/bin/env node

/**
 * Detector Precision & Recall Evaluation CLI
 * Evaluates detector performance on data/labels.jsonl using a 70/30 train/test split with Wilson 95% CIs.
 * 
 * Usage:
 *   node scripts/eval_detector_labels.js [path_to_labels.jsonl] [--split 0.70] [--seed 42]
 */

const fs = require('fs');
const path = require('path');

// Determine labels path
const defaultLabelsPath = path.resolve(__dirname, '..', 'data', 'labels.jsonl');
const args = process.argv.slice(2);
let labelsPath = defaultLabelsPath;
let splitRatio = 0.70;
let seed = 42;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--split' && args[i + 1]) {
    splitRatio = Number(args[i + 1]);
    i++;
  } else if (args[i] === '--seed' && args[i + 1]) {
    seed = Number(args[i + 1]);
    i++;
  } else if (!args[i].startsWith('--')) {
    labelsPath = path.resolve(args[i]);
  }
}

// Wilson Score 95% Confidence Interval
function computeWilsonCI(k, n, z = 1.96) {
  if (!n || n <= 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return [Number((lower * 100).toFixed(1)), Number((upper * 100).toFixed(1))];
}

// Seeded PRNG for reproducible 70/30 split
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runEvaluation() {
  console.log('\n========================================================================================');
  console.log('              VALOCOACH DETECTOR PRECISION & RECALL EVALUATION (70/30 SPLIT)            ');
  console.log('========================================================================================');
  console.log(`Source File: ${labelsPath}`);
  console.log(`Train/Test Split: ${Math.round(splitRatio * 100)}% / ${Math.round((1 - splitRatio) * 100)}% | RNG Seed: ${seed}`);

  if (!fs.existsSync(labelsPath)) {
    console.error(`\n❌ Labels file not found at: ${labelsPath}`);
    console.log('   Save verdicts using the ValoCoach frontend dev labeler to generate data/labels.jsonl.');
    console.log('========================================================================================\n');
    process.exit(1);
  }

  const rawLines = fs.readFileSync(labelsPath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  const allLabels = [];
  rawLines.forEach((line, idx) => {
    try {
      const l = JSON.parse(line);
      if (l.human_label !== 'UNSURE') allLabels.push(l); // "can't tell" is excluded from precision/recall
    } catch {
      console.warn(`[Warning] Skipping malformed JSON line ${idx + 1}`);
    }
  });

  if (allLabels.length === 0) {
    console.log('\n⚠️ Labels file is currently empty. Record human verdicts in the frontend dev tool first.');
    console.log('========================================================================================\n');
    return;
  }

  // Reproducible seeded shuffle
  const rng = mulberry32(seed);
  const shuffled = [...allLabels];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const splitIdx = Math.max(1, Math.floor(shuffled.length * splitRatio));
  const trainSet = shuffled.slice(0, splitIdx);
  const testSet = shuffled.slice(splitIdx);
  const evalSet = testSet.length > 0 ? testSet : shuffled;

  console.log(`Total Samples: ${allLabels.length} | Train: ${trainSet.length} | Test (Evaluated): ${evalSet.length}`);

  // Unique tags
  const allTags = new Set();
  shuffled.forEach(l => {
    if (l.detector_tag && l.detector_tag !== 'UNFLAGGED') allTags.add(l.detector_tag);
    if (l.human_label && l.human_label !== 'UNFLAGGED' && l.human_label !== 'CLEAN_ENGAGEMENT' && l.human_label !== 'NORMAL_TEAM_FIGHT') {
      allTags.add(l.human_label);
    }
  });

  const rows = [];
  let totalTP = 0;
  let totalFP = 0;
  let totalFN = 0;
  let totalTN = 0;

  [...allTags].sort().forEach(tag => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    evalSet.forEach(l => {
      const pred = (l.detector_tag === tag);
      const groundTruth = (l.human_label === tag) || (pred && l.justified === 'Y');

      if (pred && groundTruth) tp += 1;
      else if (pred && !groundTruth) fp += 1;
      else if (!pred && groundTruth) fn += 1;
      else tn += 1;
    });

    const precDenom = tp + fp;
    const recDenom = tp + fn;
    const precision = precDenom > 0 ? (tp / precDenom) : null;
    const recall = recDenom > 0 ? (tp / recDenom) : null;
    const f1 = (precision != null && recall != null && (precision + recall) > 0)
      ? ((2 * precision * recall) / (precision + recall))
      : 0;

    const pCI = computeWilsonCI(tp, precDenom);
    const rCI = computeWilsonCI(tp, recDenom);

    totalTP += tp;
    totalFP += fp;
    totalFN += fn;
    totalTN += tn;

    rows.push({
      tag,
      samples: precDenom + fn,
      tp,
      fp,
      fn,
      precisionPct: precision != null ? (precision * 100).toFixed(1) + '%' : 'N/A',
      precisionCI: `[${pCI[0]}%-${pCI[1]}%]`,
      recallPct: recall != null ? (recall * 100).toFixed(1) + '%' : 'N/A',
      recallCI: `[${rCI[0]}%-${rCI[1]}%]`,
      f1Score: f1.toFixed(3)
    });
  });

  console.log('\n--------------------------------------------------------------------------------------------------------------');
  console.log(
    'Detector Tag'.padEnd(28) +
    'Test N'.padStart(8) +
    'TP'.padStart(6) +
    'FP'.padStart(6) +
    'FN'.padStart(6) +
    'Precision (95% CI)'.padStart(24) +
    'Recall (95% CI)'.padStart(24) +
    'F1'.padStart(9)
  );
  console.log('--------------------------------------------------------------------------------------------------------------');

  rows.forEach(r => {
    const pStr = `${r.precisionPct} ${r.precisionCI}`.padStart(24);
    const rStr = `${r.recallPct} ${r.recallCI}`.padStart(24);
    console.log(
      r.tag.padEnd(28) +
      String(r.samples).padStart(8) +
      String(r.tp).padStart(6) +
      String(r.fp).padStart(6) +
      String(r.fn).padStart(6) +
      pStr +
      rStr +
      r.f1Score.padStart(9)
    );
  });

  console.log('--------------------------------------------------------------------------------------------------------------');

  const validPrec = rows.filter(r => r.precisionPct !== 'N/A').map(r => parseFloat(r.precisionPct));
  const validRec = rows.filter(r => r.recallPct !== 'N/A').map(r => parseFloat(r.recallPct));
  const validF1 = rows.map(r => parseFloat(r.f1Score));

  const macroP = validPrec.length > 0 ? (validPrec.reduce((a, b) => a + b, 0) / validPrec.length).toFixed(1) : 0;
  const macroR = validRec.length > 0 ? (validRec.reduce((a, b) => a + b, 0) / validRec.length).toFixed(1) : 0;
  const macroF1 = validF1.length > 0 ? (validF1.reduce((a, b) => a + b, 0) / validF1.length).toFixed(3) : 0;

  const microPNum = totalTP;
  const microPDenom = totalTP + totalFP;
  const microRDenom = totalTP + totalFN;
  const microP = microPDenom > 0 ? ((microPNum / microPDenom) * 100).toFixed(1) : 0;
  const microR = microRDenom > 0 ? ((microPNum / microRDenom) * 100).toFixed(1) : 0;
  const microF1 = (parseFloat(microP) + parseFloat(microR) > 0)
    ? ((2 * (microP / 100) * (microR / 100)) / ((parseFloat(microP) + parseFloat(microR)) / 100)).toFixed(3)
    : 0;

  const justifiedCount = evalSet.filter(l => l.justified === 'Y').length;
  const agreementRate = ((justifiedCount / evalSet.length) * 100).toFixed(1);

  console.log(`\n• Overall Justified Agreement Rate: ${agreementRate}% (${justifiedCount}/${evalSet.length})`);
  console.log(`• Macro Average:  Precision = ${macroP}% | Recall = ${macroR}% | F1-Score = ${macroF1}`);
  console.log(`• Micro Average:  Precision = ${microP}% | Recall = ${microR}% | F1-Score = ${microF1}`);
  console.log('========================================================================================\n');
}

runEvaluation();
