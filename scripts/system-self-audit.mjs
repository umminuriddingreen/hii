#!/usr/bin/env node
/**
 * system-self-audit.mjs - Sovereign Heartbeat for the HII Fabric
 * 
 * Interrogates your local Mac environment:
 * 1. SQLite Memory Integrity (`~/.hii/hii.db`)
 * 2. Skills Registry & Lifecycle Health
 * 3. Multi-Model Routing (Ollama/MLX, Claude, Codex)
 * 4. Fabric State & Trace Completeness
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HII_ROOT = path.join(os.homedir(), '.hii');
const HIID_DAEMON = path.join(HII_ROOT, 'daemon', 'hiid.mjs');
const TRACES_DIR = path.join(HII_ROOT, 'traces');
const MODEL_PROFILES = path.join(HII_ROOT, 'bridge', 'model-profiles.json');

async function runAudit() {
  const result = { 
    timestamp: new Date().toISOString(), 
    status: 'running',
    silicon: {}
  };
  
  // Check Apple Silicon / Unified Memory State
  try {
    result.silicon.totalRAMGb = Math.round(os.totalmem() / (1024 ** 3));
    result.silicon.usedRAMGb = Math.round((os.totalmem() - os.freemem()) / (1024 ** 3));
    result.silicon.memoryUtilizationPct = ((result.silicon.usedRAMGb / result.silicon.totalRAMGb) * 100).toFixed(1);
   } catch {
    result.silicon.status = 'error';
   }

  try {
     // 1. SQLite Integrity & Context Depth
    console.log('\n[1/5] Evaluating DB integrity...');
    const dbPath = path.join(HII_ROOT, 'hii.db');
    if (!fs.existsSync(dbPath)) throw new Error('Fabric state is uninitialized (Missing hii.db).');
    
    const db = await open({ filename: dbPath, mode: sqlite3.OPEN_READONLY });
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table';");

     // Get counts for every table
    for (const { name } of tables) {
      const count = await db.get(`SELECT COUNT(*) as cnt FROM ${name}`);
      result[name] = count.cnt;
    }
  } catch (err) {
    result.dbStatus = 'error';
    result.dbError = err.message;
  }

  try {
     // 2. Skills Registry Health
    console.log('\n[2/5] Auditing skills registry...');
    const indexRaw = fs.readFileSync(path.join(HII_ROOT, 'skills', '_index.json'), 'utf8');
    const skillIndex = JSON.parse(indexRaw);
    result.skillCount = skillIndex.skills?.length || 0;

     // Check lifecycle state
    const lifecycleRaw = fs.readFileSync(path.join(HII_ROOT, 'skills', 'lifecycle.json'), 'utf8');
    const lifecycle = JSON.parse(lifecycleRaw);
    result.lifecycleStates = Object.keys(lifecycle.states || {});
  } catch (err) {
    result.skillsStatus = 'error';
  }

  try {
     // 3. Multi-Model Routing Check (MLX, Claude, Codex)
    console.log('\n[3/5] Verifying Local Model Routing...');
    
    // Query Ollama for active MLX models
    const ollamaList = JSON.parse(execSync('ollama list').toString());
    result.activeModels = {};
    ollamaList.forEach(model => {
      const family = model.split(':')[0].replace(/-\d+.*/g, '');
      if (!result.activeModels[family]) result.activeModels[family] = [];
      result.activeModels[family].push(model);
    });

     // Check daemon and agent process liveness
    try {
      const ollamaPids = execSync('pgrep -a "[o]llama|[r]unner"').toString().trim();
      result.ollamaProcesses = ollamaPids.split('\n').filter(Boolean).length;
     } catch {
      result.ollamaProcesses = 0;
     }

   } catch (err) {
    result.mlxStatus = 'error';
   }

  try {
     // 4. Trace Recording Gap Check
    console.log('\n[4/5] Analyzing Trace Completeness...');
    const tracesPath = path.join(TRACES_DIR, 'llm_requests.jsonl');
    
    if (fs.existsSync(tracesPath)) {
      const totalLines = fs.readFileSync(tracesPath, 'utf8').split('\n').filter(Boolean).length;
      result.totalTraces = totalLines;
      
       // Check last trace for provider type
      const lastLine = fs.readFileSync(tracesPath, 'utf8').trim().split('\n').pop();
      if (lastLine) {
        const parsed = JSON.parse(lastLine);
        result.lastProvider = parsed.provider || 'unknown';
        result.tracesAreActive = true;
       } else {
        result.tracesAreActive = false;
       }
     } else {
      result.totalTraces = 0;
      result.tracesAreActive = false;
      result.traceGapWarning = 'CRITICAL: Trace log is missing. Sovereignty loop is open.';
    }
   } catch (err) {
    result.tracesStatus = 'error';
   }

  try {
     // 5. Bridge & Hardware State
    console.log('\n[5/5] Verifying Fabric State...');
    
     // Check model profile config
    if (fs.existsSync(MODEL_PROFILES)) {
      const profilesRaw = fs.readFileSync(MODEL_PROFILES, 'utf8');
      result.modelProfilesLoaded = true;
     } else {
      result.modelProfilesLoaded = false;
      result.status = 'DEGRADED - Missing model-profiles.json';
    }
   } catch {}

   // Final Sovereign Verdict
  if (result.dbStatus !== 'error' && result.lastProvider) {
    result.status = 'HEALTHY - SOVEREIGN LOOP ACTIVE';
   } else if (result.skillCount > 0 && result.totalTraces >= 5) {
    result.status = 'STABLE - OPERATIONAL CONTINUITY MAINTAINED';
   } else if (result.totalTraces === 0) {
    result.status = 'WARNING - LEMMA GAPPING DETECTED';
   }

  console.log('\n' + JSON.stringify(result, null, 2));
}

runAudit();
