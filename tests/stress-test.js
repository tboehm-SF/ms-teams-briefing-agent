#!/usr/bin/env node

/**
 * MS Teams Briefing Agent — Stress Test Suite
 *
 * Tests the Heroku-deployed app under concurrent load.
 * Validates auth stability, session creation, message throughput, and file uploads.
 *
 * Usage:
 *   node tests/stress-test.js [BASE_URL]
 *
 * Examples:
 *   node tests/stress-test.js                          # defaults to http://localhost:3000
 *   node tests/stress-test.js https://your-app.herokuapp.com
 *
 * Environment:
 *   STRESS_BASE_URL  — alternative to CLI arg
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.argv[2] || process.env.STRESS_BASE_URL || 'http://localhost:3000';

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  healthCheckCount: 50,
  sessionBurstCount: 10,
  messageConcurrency: 5,
  messagesPerSession: 2,
  fileUploadCount: 5,
  e2eFlowCount: 3
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const results = {
  tests: [],
  startTime: null,
  endTime: null
};

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(32, t);
const red = (t) => color(31, t);
const yellow = (t) => color(33, t);
const cyan = (t) => color(36, t);
const bold = (t) => color(1, t);

async function httpRequest(method, urlPath, body = null, options = {}) {
  const url = `${BASE_URL}${urlPath}`;
  const startTime = Date.now();

  const fetchOptions = {
    method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(options.timeout || 60000)
  };

  if (body && method !== 'GET') {
    if (body instanceof FormData) {
      delete fetchOptions.headers['Content-Type']; // let fetch set multipart boundary
      fetchOptions.body = body;
    } else {
      fetchOptions.body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(url, fetchOptions);
    const data = await response.json().catch(() => null);
    const latencyMs = Date.now() - startTime;

    return {
      ok: response.ok,
      status: response.status,
      data,
      latencyMs,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      latencyMs: Date.now() - startTime,
      error: err.message
    };
  }
}

function computeStats(latencies) {
  if (latencies.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };

  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  return { avg, p50, p95, p99, min, max };
}

function recordTest(name, passed, failed, latencies, errors = []) {
  const stats = computeStats(latencies);
  results.tests.push({
    name,
    passed,
    failed,
    total: passed + failed,
    stats,
    errors: errors.slice(0, 5) // keep top 5 errors
  });
}

/**
 * Run N tasks concurrently with a concurrency limit
 */
async function runConcurrent(tasks, limit = 10) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const promise = task().then((result) => {
      executing.delete(promise);
      return result;
    });
    executing.add(promise);
    results.push(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ─── Test Scenarios ──────────────────────────────────────────────────────────

async function testHealthCheck() {
  console.log(cyan('\n━━━ Test 1: Health Check Burst ━━━'));
  console.log(`  Sending ${CONFIG.healthCheckCount} rapid GET /api/health requests...`);

  const tasks = Array.from({ length: CONFIG.healthCheckCount }, () =>
    () => httpRequest('GET', '/api/health')
  );

  const responses = await runConcurrent(tasks, 20);

  const passed = responses.filter(r => r.ok).length;
  const failed = responses.filter(r => !r.ok).length;
  const latencies = responses.filter(r => r.ok).map(r => r.latencyMs);
  const errors = responses.filter(r => !r.ok).map(r => r.error || `HTTP ${r.status}`);

  recordTest('Health Check Burst', passed, failed, latencies, errors);

  const stats = computeStats(latencies);
  console.log(`  ${green('✓ Passed')}: ${passed}/${CONFIG.healthCheckCount}`);
  if (failed > 0) console.log(`  ${red('✗ Failed')}: ${failed}`);
  console.log(`  Latency: avg=${stats.avg}ms, p95=${stats.p95}ms, p99=${stats.p99}ms`);
}

async function testSessionCreation() {
  console.log(cyan('\n━━━ Test 2: Session Creation Burst ━━━'));
  console.log(`  Creating ${CONFIG.sessionBurstCount} concurrent agent sessions...`);

  const tasks = Array.from({ length: CONFIG.sessionBurstCount }, () =>
    () => httpRequest('POST', '/api/agent/session')
  );

  const responses = await runConcurrent(tasks, CONFIG.sessionBurstCount);

  const passed = responses.filter(r => r.ok && r.data?.success).length;
  const failed = responses.filter(r => !r.ok || !r.data?.success).length;
  const latencies = responses.filter(r => r.ok).map(r => r.latencyMs);
  const errors = responses.filter(r => !r.ok || !r.data?.success)
    .map(r => r.data?.error || r.error || `HTTP ${r.status}`);
  const sessionIds = responses.filter(r => r.data?.sessionId).map(r => r.data.sessionId);

  recordTest('Session Creation Burst', passed, failed, latencies, errors);

  const stats = computeStats(latencies);
  console.log(`  ${green('✓ Passed')}: ${passed}/${CONFIG.sessionBurstCount}`);
  if (failed > 0) console.log(`  ${red('✗ Failed')}: ${failed}`);
  console.log(`  Latency: avg=${stats.avg}ms, p95=${stats.p95}ms`);
  console.log(`  Sessions created: ${sessionIds.length}`);

  // Clean up sessions
  for (const sid of sessionIds) {
    await httpRequest('POST', '/api/agent/end', { sessionId: sid });
  }

  return sessionIds;
}

async function testMessageLoad() {
  console.log(cyan('\n━━━ Test 3: Message Load ━━━'));
  console.log(`  ${CONFIG.messageConcurrency} concurrent sessions, ${CONFIG.messagesPerSession} messages each...`);

  // Create sessions first
  const sessionTasks = Array.from({ length: CONFIG.messageConcurrency }, () =>
    () => httpRequest('POST', '/api/agent/session')
  );
  const sessionResponses = await runConcurrent(sessionTasks, 5);
  const sessions = sessionResponses.filter(r => r.data?.sessionId).map(r => r.data.sessionId);

  if (sessions.length === 0) {
    console.log(red('  ✗ No sessions could be created — skipping message test'));
    recordTest('Message Load', 0, CONFIG.messageConcurrency, [], ['No sessions created']);
    return;
  }

  console.log(`  Created ${sessions.length} sessions, sending messages...`);

  const allLatencies = [];
  const allErrors = [];
  let totalPassed = 0;
  let totalFailed = 0;

  // Send messages per session (sequentially within each session, parallel across sessions)
  const messageTasks = sessions.map((sessionId, idx) => async () => {
    for (let i = 0; i < CONFIG.messagesPerSession; i++) {
      const msg = i === 0
        ? `Hallo, ich bin Testbenutzer ${idx + 1}. Welche Events gibt es?`
        : `Danke fuer die Info. Bitte erstelle ein Testevent "Stresstest ${idx}-${i}" am 20. April 2025 in Bern fuer 50 Personen.`;

      const result = await httpRequest('POST', '/api/agent/message', {
        sessionId,
        message: msg
      }, { timeout: 120000 });

      if (result.ok && result.data?.success) {
        totalPassed++;
        allLatencies.push(result.latencyMs);
      } else {
        totalFailed++;
        allErrors.push(result.data?.error || result.error || `HTTP ${result.status}`);
      }
    }
  });

  await runConcurrent(messageTasks, CONFIG.messageConcurrency);

  const totalMessages = CONFIG.messageConcurrency * CONFIG.messagesPerSession;
  recordTest('Message Load', totalPassed, totalFailed, allLatencies, allErrors);

  const stats = computeStats(allLatencies);
  console.log(`  ${green('✓ Passed')}: ${totalPassed}/${totalMessages}`);
  if (totalFailed > 0) console.log(`  ${red('✗ Failed')}: ${totalFailed}`);
  console.log(`  Latency: avg=${stats.avg}ms, p95=${stats.p95}ms, max=${stats.max}ms`);

  // Clean up sessions
  for (const sid of sessions) {
    await httpRequest('POST', '/api/agent/end', { sessionId: sid });
  }
}

async function testFileUpload() {
  console.log(cyan('\n━━━ Test 4: File Upload Stress ━━━'));
  console.log(`  Uploading ${CONFIG.fileUploadCount} files concurrently...`);

  const samplePath = path.join(__dirname, 'fixtures', 'sample-briefing.txt');
  let fileContent;
  try {
    fileContent = fs.readFileSync(samplePath, 'utf-8');
  } catch (err) {
    console.log(yellow('  ⚠ Sample file not found, using inline test content'));
    fileContent = 'Event-Briefing: Testevent\nDatum: 15. Maerz 2025\nOrt: Bern\nKapazitaet: 100\nBudget: CHF 10000';
  }

  // Create multipart form data for each upload
  const tasks = Array.from({ length: CONFIG.fileUploadCount }, (_, i) => async () => {
    const url = `${BASE_URL}/api/upload`;
    const formData = new FormData();
    const blob = new Blob([fileContent], { type: 'text/plain' });
    formData.append('file', blob, `test-briefing-${i + 1}.txt`);

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(30000)
      });
      const data = await response.json().catch(() => null);
      return {
        ok: response.ok,
        status: response.status,
        data,
        latencyMs: Date.now() - startTime,
        error: null
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        latencyMs: Date.now() - startTime,
        error: err.message
      };
    }
  });

  const responses = await runConcurrent(tasks, CONFIG.fileUploadCount);

  const passed = responses.filter(r => r.ok && r.data?.success).length;
  const failed = responses.filter(r => !r.ok || !r.data?.success).length;
  const latencies = responses.filter(r => r.ok).map(r => r.latencyMs);
  const errors = responses.filter(r => !r.ok || !r.data?.success)
    .map(r => r.data?.error || r.error || `HTTP ${r.status}`);

  recordTest('File Upload Stress', passed, failed, latencies, errors);

  const stats = computeStats(latencies);
  console.log(`  ${green('✓ Passed')}: ${passed}/${CONFIG.fileUploadCount}`);
  if (failed > 0) console.log(`  ${red('✗ Failed')}: ${failed}`);
  console.log(`  Latency: avg=${stats.avg}ms, p95=${stats.p95}ms`);
}

async function testE2EFlow() {
  console.log(cyan('\n━━━ Test 5: End-to-End Flow ━━━'));
  console.log(`  ${CONFIG.e2eFlowCount} concurrent full flows (session → upload → message → end)...`);

  const samplePath = path.join(__dirname, 'fixtures', 'sample-briefing.txt');
  let fileContent;
  try {
    fileContent = fs.readFileSync(samplePath, 'utf-8');
  } catch (err) {
    fileContent = 'Event-Briefing: E2E Test\nDatum: 20. Juni 2025\nOrt: Zuerich\nKapazitaet: 200\nBudget: CHF 25000';
  }

  const flowResults = [];

  const tasks = Array.from({ length: CONFIG.e2eFlowCount }, (_, i) => async () => {
    const flowStart = Date.now();
    const steps = { session: null, upload: null, message: null, end: null };
    const errors = [];

    // Step 1: Create session
    const sessionRes = await httpRequest('POST', '/api/agent/session');
    steps.session = { ok: sessionRes.ok, latencyMs: sessionRes.latencyMs };

    if (!sessionRes.ok || !sessionRes.data?.sessionId) {
      errors.push(`Session creation failed: ${sessionRes.data?.error || sessionRes.error}`);
      flowResults.push({ ok: false, steps, errors, totalMs: Date.now() - flowStart });
      return;
    }

    const sessionId = sessionRes.data.sessionId;

    // Step 2: Upload file
    const formData = new FormData();
    const blob = new Blob([fileContent], { type: 'text/plain' });
    formData.append('file', blob, `e2e-briefing-${i + 1}.txt`);

    const uploadStart = Date.now();
    try {
      const uploadResponse = await fetch(`${BASE_URL}/api/upload`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(30000)
      });
      const uploadData = await uploadResponse.json().catch(() => null);
      steps.upload = { ok: uploadResponse.ok, latencyMs: Date.now() - uploadStart };

      if (!uploadResponse.ok || !uploadData?.success) {
        errors.push(`Upload failed: ${uploadData?.error || 'unknown'}`);
      }

      // Step 3: Send extracted text to agent
      const extractedText = uploadData?.text || fileContent;
      const messageRes = await httpRequest('POST', '/api/agent/message', {
        sessionId,
        message: `Bitte erstelle das Event aus folgendem Briefing:\n\n${extractedText}`
      }, { timeout: 120000 });
      steps.message = { ok: messageRes.ok, latencyMs: messageRes.latencyMs };

      if (!messageRes.ok || !messageRes.data?.success) {
        errors.push(`Message failed: ${messageRes.data?.error || messageRes.error}`);
      }
    } catch (err) {
      steps.upload = steps.upload || { ok: false, latencyMs: Date.now() - uploadStart };
      errors.push(`Upload/message error: ${err.message}`);
    }

    // Step 4: End session
    const endRes = await httpRequest('POST', '/api/agent/end', { sessionId });
    steps.end = { ok: endRes.ok, latencyMs: endRes.latencyMs };

    flowResults.push({
      ok: errors.length === 0,
      steps,
      errors,
      totalMs: Date.now() - flowStart
    });
  });

  await runConcurrent(tasks, CONFIG.e2eFlowCount);

  const passed = flowResults.filter(f => f.ok).length;
  const failed = flowResults.filter(f => !f.ok).length;
  const totalLatencies = flowResults.map(f => f.totalMs);
  const allErrors = flowResults.flatMap(f => f.errors);

  recordTest('E2E Flow', passed, failed, totalLatencies, allErrors);

  const stats = computeStats(totalLatencies);
  console.log(`  ${green('✓ Passed')}: ${passed}/${CONFIG.e2eFlowCount}`);
  if (failed > 0) console.log(`  ${red('✗ Failed')}: ${failed}`);
  console.log(`  Total flow time: avg=${stats.avg}ms, p95=${stats.p95}ms, max=${stats.max}ms`);

  // Print step breakdown
  for (const step of ['session', 'upload', 'message', 'end']) {
    const stepLatencies = flowResults
      .map(f => f.steps[step]?.latencyMs)
      .filter(Boolean);
    if (stepLatencies.length > 0) {
      const stepStats = computeStats(stepLatencies);
      console.log(`    ${step}: avg=${stepStats.avg}ms, max=${stepStats.max}ms`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold('\n╔══════════════════════════════════════════════════════╗'));
  console.log(bold('║  MS Teams Briefing Agent — Stress Test Suite         ║'));
  console.log(bold('╚══════════════════════════════════════════════════════╝'));
  console.log(`\n  Target: ${cyan(BASE_URL)}`);
  console.log(`  Time:   ${new Date().toISOString()}\n`);

  results.startTime = Date.now();

  // Pre-check: is the server reachable?
  console.log('  Checking server connectivity...');
  const ping = await httpRequest('GET', '/api/health');
  if (!ping.ok) {
    console.log(red(`\n  ✗ Server not reachable at ${BASE_URL}`));
    console.log(`    Error: ${ping.error || `HTTP ${ping.status}`}`);
    console.log('    Make sure the app is running and the URL is correct.\n');
    process.exit(1);
  }

  const healthData = ping.data;
  console.log(green('  ✓ Server is reachable'));
  console.log(`    Status: ${healthData?.status || 'unknown'}`);
  console.log(`    Auth: ${healthData?.auth?.authenticated ? green('authenticated') : red('NOT authenticated')}`);
  console.log(`    Uptime: ${healthData?.uptime || '?'}s`);

  if (!healthData?.auth?.authenticated) {
    console.log(red('\n  ✗ Server is not authenticated to Salesforce'));
    console.log('    Configure SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD on Heroku.');
    console.log('    Stress tests require a live Salesforce connection.\n');
    process.exit(1);
  }

  // Run all tests
  await testHealthCheck();
  await testSessionCreation();
  await testMessageLoad();
  await testFileUpload();
  await testE2EFlow();

  results.endTime = Date.now();

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log(bold('\n╔══════════════════════════════════════════════════════╗'));
  console.log(bold('║  STRESS TEST SUMMARY                                ║'));
  console.log(bold('╚══════════════════════════════════════════════════════╝'));

  const totalDuration = ((results.endTime - results.startTime) / 1000).toFixed(1);
  console.log(`\n  Total duration: ${totalDuration}s\n`);

  console.log('  ' + '─'.repeat(70));
  console.log(`  ${'Test'.padEnd(25)} ${'Passed'.padEnd(10)} ${'Failed'.padEnd(10)} ${'Avg(ms)'.padEnd(10)} ${'P95(ms)'.padEnd(10)} ${'Max(ms)'.padEnd(10)}`);
  console.log('  ' + '─'.repeat(70));

  let allPassed = true;
  for (const test of results.tests) {
    const statusIcon = test.failed === 0 ? green('✓') : red('✗');
    const passedStr = test.failed === 0
      ? green(String(test.passed).padEnd(10))
      : String(test.passed).padEnd(10);
    const failedStr = test.failed > 0
      ? red(String(test.failed).padEnd(10))
      : String(test.failed).padEnd(10);

    console.log(
      `  ${statusIcon} ${test.name.padEnd(23)} ${passedStr} ${failedStr} ` +
      `${String(test.stats.avg).padEnd(10)} ${String(test.stats.p95).padEnd(10)} ${String(test.stats.max).padEnd(10)}`
    );

    if (test.failed > 0) {
      allPassed = false;
      for (const err of test.errors) {
        console.log(`    ${red('→')} ${err}`);
      }
    }
  }

  console.log('  ' + '─'.repeat(70));

  if (allPassed) {
    console.log(green('\n  ✓ ALL TESTS PASSED\n'));
  } else {
    console.log(red('\n  ✗ SOME TESTS FAILED — see errors above\n'));
  }

  // Final health check
  const finalHealth = await httpRequest('GET', '/api/health');
  if (finalHealth.ok && finalHealth.data) {
    console.log('  Post-test health:');
    console.log(`    Auth: ${finalHealth.data.auth?.authenticated ? green('OK') : red('FAILED')}`);
    console.log(`    Memory: ${finalHealth.data.memory?.heapUsed || '?'}`);
    console.log(`    Agent metrics: ${JSON.stringify(finalHealth.data.agent || {})}`);
  }

  console.log('');
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(red('Stress test crashed:'), err);
  process.exit(2);
});
