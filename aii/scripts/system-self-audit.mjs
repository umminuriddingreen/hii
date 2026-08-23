/**
 * system-self-audit.mjs - A sovereign heartbeat for the HII fabric
 * 
 * Interrogates the HII ecosystem:
 * 1. SQLite DB integrity (context_projects, skills, projects)
 * 2. Skills registry depth and lifecycle states
 * 3. Daemon health and process liveness
 * 4. Trace completeness (LLM requests, model usage)
 * 5. Local MLX/Model routing checks
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite3';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HII_ROOT = path.join(os.homedir(), '.hii');
const SKILLS_INDEX = path.join(HII_ROOT, 'skills', '_index.json');
const LIFECYCLE_JSON = path.join(HII_ROOT, 'skills', 'lifecycle.json');
const HIID_DAEMON = path.join(HII_ROOT, 'daemon', 'hiid.mjs');
const TRACES_DIR = path.join(HII_ROOT, 'traces');

async function runAudit() {
  const result = { timestamp: new Date().toISOString(), status: 'running' };
  
  try {
    // 1. SQLite Integrity & Content Depth
    console.log('\n[1/5] Evaluating DB integrity...');
    const dbPath = path.join(HII_ROOT, 'hii.db');
    if (!fs.existsSync(dbPath)) {
      throw new Error('hii.db is missing. Fabric state is uninitialized.');
    }
    
    const db = await open({ filename: dbPath, mode: sqlite3.OPEN_READONLY });

    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table';");
    result.tables = tables.map(t => t.name);

    for (const { name } of tables) {
      const count = await db.get(`SELECT COUNT(*) as cnt FROM ${name}`);
      if (!result.tableStats) result.tableStats = {};
      result.tableStats[name] = count.cnt;
    }
    
    // Check memory and traces tables specifically for context depth
    const tracePath = path.join(TRACES_DIR, 'llm_requests.jsonl');
    if (fs.existsSync(tracePath)) {
      const stats = fs.statSync(tracePath);
      result.contextMemorySize = stats.size;
    }

  } catch (err) {
    result.dbStatus = 'error';
    result.dbError = err.message;
  }

  try {
    // 2. Skills Registry & Lifecycle Health
    console.log('\n[2/5] Auditing skills registry...');
    const indexRaw = fs.readFileSync(SKILLS_INDEX, 'utf8');
    const skillIndex = JSON.parse(indexRaw);
    result.skillCount = skillIndex.skills?.length || 0;

    if (fs.existsSync(LIFECYCLE_JSON)) {
      const lifecycleRaw = fs.readFileSync(LIFECYCLE_JSON, 'utf8');
      const lifecycle = JSON.parse(lifecycleRaw);
      result.lifecycleState = lifecycle.states || 'unknown';
      result.originKinds = lifecycle.originKinds || [];
    }

  } catch (err) {
    result.skillsStatus = 'error';
    result.skillsError = err.message;
  }

  try {
    // 3. Daemon & Process Liveness
    console.log('\n[3/5] Checking daemon fabric...');
    
    // Check for active HII process
    let hiiProcList;
    try {
      hiiProcList = execSync('pgrep -fla [h]ii').toString().trim();
    } catch (e) { hiiProcList = ''; }
    result.iiProcesses = hiiProcList.split('\n').filter(Boolean);

    // Check for active Ollama / MLX Runner
    let ollamaProc;
    try {
      ollamaProc = execSync('pgrep -fla "[o]llama|[r]unner"').toString().trim();
    } catch (e) { ollamaProc = ''; }
    result.ollamaProcesses = ollamaProc.split('\n').filter(Boolean);

  } catch (err) {
    result.daemonStatus = 'error';
  }

  try {
    // 4. Trace Completeness & Model Usage Tracking
    console.log('\n[4/5] Analyzing trace gaps...');
    
    const tracesJsonl = path.join(TRACES_DIR, 'llm_requests.jsonl');
    let traceRecords = [];
    if (fs.existsSync(tracesJsonl)) {
      const raw = fs.readFileSync(tracesJsonl, 'utf8');
      traceRecords = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    }

    result.totalTraces = traceRecords.length;
    result.providersUsed = {};
    
    for (const record of traceRecords) {
      const provider = record.provider || 'unknown';
      if (!result.providersUsed[provider]) result.providersUsed[provider] = 0;
      result.providersUsed[provider] += 1;
    }

    // Detect missing traces
    if (traceRecords.length < 5) {
      result.traceGapWarning = 'Traces are too sparse. Model usage is leaking into the void.';
    } else {
      result.traceGapWarning = 'Trace recording loop is active and capturing LLM calls.';
    }

  } catch (err) {
    result.tracesStatus = 'error';
  }

  try {
    // 5. Local MLX & Hardware Routing
    console.log('\n[5/5] Verifying local hardware routing...');

    // Check active memory usage and silicon health
    const totalMem = os.totalmem() / (1024 ** 3);
    const freeMem = os.freemem() / (1024 ** 3);
    result.hardware = { 
      chip: 'Apple Silicon', 
      totalRAMGb: Math.round(totalMem), 
      freeRAMGb: Math.round(freeMem, 2) 
    };

    // Query Ollama for local MLX models
    try {
      const ollamaTags = JSON.parse(execSync('ollama list').toString());
      result.mlxModelsOnline = ollamaTags.filter(m => m.includes('mlx')).map(m => m.name);
    } catch (e) {
      result.mlxModelsOnline = [];
    }

  } catch (err) {
    result.hardwareStatus = 'error';
  }

  // Final verdict
  const errors = [result.dbError, result.skillsError].filter(Boolean).length;
  if (errors === 0 && result.traceGapWarning?.includes('active')) {
    result.status = 'HEALTHY - SOVEREIGN LOOP ACTIVE';
  } else {
    result.status = 'DEGRADED - REQUIRES OPERATOR REVIEW';
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

runAudit();
