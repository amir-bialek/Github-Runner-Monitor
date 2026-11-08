// Story 7.1: network probe run inside a pod of the attack test cluster.
//
//   PROBE_MODE=job      from a pod with the Debug Job labels (SR3): every
//                       forbidden target must fail, every allowed one answer.
//   PROBE_MODE=control  from a pod without them: the bystanders answer and the
//                       backend ports stay closed (the backend's own policy).
//
// Targets come from the environment (set by attack-test.sh):
//   BACKEND_SVC      backend Service DNS name
//   BACKEND_POD_IP   backend pod IP
//   MAIN_PORT        backend main port (3001)
//   RESULTS_PORT     backend results port (3002)
//   API_SERVER       Kubernetes API server endpoint, ip:port (job mode)
//   BYSTANDERS       comma list of name=ip:port, pods with no policy of their own
//   ANTHROPIC_URL    default https://api.anthropic.com/v1/models (job mode;
//                    unauthenticated, any HTTP answer counts)
//
// Every attempt is made for real. A forbidden target passes only if the
// connection (or the DNS answer) does not come within 3 s; a host name that
// does not resolve is a FAIL, because then nothing was attempted. Prints
// "ok   - ..." / "FAIL - ..." lines and exits 1 on any FAIL.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const BLOCK_TIMEOUT_MS = 3000;
const ALLOW_TIMEOUT_MS = 10000;

const env = process.env;
const mode = env.PROBE_MODE;
let failed = 0;

function ok(message) {
  console.log(`ok   - ${mode}: ${message}`);
}
function fail(message) {
  failed += 1;
  console.log(`FAIL - ${mode}: ${message}`);
}

function required(name) {
  const value = (env[name] ?? '').trim();
  if (value === '') {
    console.log(`FAIL - probe: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

function hostPort(value) {
  const i = (value ?? '').lastIndexOf(':');
  const host = i > 0 ? value.slice(0, i) : '';
  const port = Number(i > 0 ? value.slice(i + 1) : NaN);
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

async function resolve(host) {
  if (net.isIP(host)) return host;
  const { address } = await dns.lookup(host);
  return address;
}

/** Resolves to 'connected' or the reason the connection did not open. */
function tcpConnect(host, port, timeoutMs) {
  return new Promise((done) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      done('timeout');
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      done('connected');
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      done(error.code || 'error');
    });
  });
}

/** Resolves to the HTTP status, or the reason no answer came. */
function httpGet(url, timeoutMs) {
  return new Promise((done) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      done(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => done(error.code || error.message));
  });
}

/** One DNS query for example.com over UDP; resolves to true when anything answers. */
function udpDnsAnswers(server, timeoutMs) {
  const name = Buffer.concat([
    ...'example.com'.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);
  const query = Buffer.concat([
    Buffer.from([0x7a, 0x11, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    name,
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
  ]);
  return new Promise((done) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (answered) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      done(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('message', () => finish(true));
    socket.once('error', () => finish(false));
    socket.send(query, 53, server);
  });
}

async function expectTcpBlocked(label, target) {
  const parsed = hostPort(target);
  if (parsed === null) {
    fail(`${label} ${target}: not a host:port, so the connection was not attempted`);
    return;
  }
  const { host, port } = parsed;
  let address;
  try {
    address = await resolve(host);
  } catch {
    fail(`${label} ${target}: ${host} did not resolve, so the connection was not attempted`);
    return;
  }
  const outcome = await tcpConnect(address, port, BLOCK_TIMEOUT_MS);
  // Calico drops denied packets. A refused connection means the packet got
  // through to a host with nothing listening: not proof of the policy.
  if (outcome === 'connected') fail(`${label} ${target} (${address}) answered, must be blocked`);
  else if (outcome === 'ECONNREFUSED') fail(`${label} ${target} (${address}) refused, so the policy did not drop it`);
  else ok(`${label} ${target} blocked (${outcome})`);
}

async function expectTcpOpen(label, target) {
  const parsed = hostPort(target);
  if (parsed === null) {
    fail(`${label} ${target}: not a host:port`);
    return;
  }
  let address;
  try {
    address = await resolve(parsed.host);
  } catch {
    fail(`${label} ${target}: ${parsed.host} did not resolve`);
    return;
  }
  const outcome = await tcpConnect(address, parsed.port, ALLOW_TIMEOUT_MS);
  if (outcome === 'connected') ok(`${label} ${target} reachable without the Debug Job labels`);
  else fail(`${label} ${target} (${address}) not reachable without the Debug Job labels (${outcome})`);
}

async function expectUdpDnsAnswers(server) {
  if (await udpDnsAnswers(server, ALLOW_TIMEOUT_MS)) ok(`UDP DNS query to ${server}:53 answered without the Debug Job labels`);
  else fail(`UDP DNS query to ${server}:53 not answered without the Debug Job labels`);
}

async function expectUdpDnsBlocked(server) {
  if (await udpDnsAnswers(server, BLOCK_TIMEOUT_MS)) fail(`UDP DNS query to ${server}:53 answered, must be blocked`);
  else ok(`UDP DNS query to ${server}:53 blocked (no answer)`);
}

async function expectHttpAnswers(label, url) {
  // Allowed targets only: up to three tries, so one slow answer from the
  // internet does not fail the run. Blocked targets are tried once.
  let outcome;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    outcome = await httpGet(url, ALLOW_TIMEOUT_MS);
    if (typeof outcome === 'number') break;
  }
  if (typeof outcome === 'number') ok(`${label} ${url} answered (HTTP ${outcome})`);
  else fail(`${label} ${url} did not answer (${outcome}), must be allowed`);
}

async function expectDnsAnswers(host) {
  try {
    const { address } = await dns.lookup(host);
    ok(`cluster DNS resolves ${host} (${address})`);
  } catch (error) {
    fail(`cluster DNS did not resolve ${host} (${error.code || error.message}), must be allowed`);
  }
}

function bystanders() {
  return required('BYSTANDERS')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, target] = entry.split('=');
      return { name, target: target ?? '' };
    });
}

async function jobMode() {
  const backendSvc = required('BACKEND_SVC');
  const backendPod = required('BACKEND_POD_IP');
  const mainPort = required('MAIN_PORT');
  const resultsPort = required('RESULTS_PORT');
  const apiServer = required('API_SERVER');
  const anthropicUrl = env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/models';

  // Allowed first: if these fail the network is dead and nothing below proves anything.
  await expectDnsAnswers(backendSvc);
  await expectHttpAnswers('Anthropic API', anthropicUrl);
  await expectHttpAnswers('backend results port (Service)', `http://${backendSvc}:${resultsPort}/`);
  await expectHttpAnswers('backend results port (pod)', `http://${backendPod}:${resultsPort}/`);

  const blocked = [
    ['GitHub', 'github.com:443'],
    ['GitHub API', 'api.github.com:443'],
    ['Anthropic API on a port other than 443', 'api.anthropic.com:80'],
    ['cloud metadata', '169.254.169.254:80'],
    ['Kubernetes API (Service)', 'kubernetes.default.svc:443'],
    ['Kubernetes API (endpoint)', apiServer],
    ['backend main port (Service)', `${backendSvc}:${mainPort}`],
    ['backend main port (pod)', `${backendPod}:${mainPort}`],
    ...bystanders().map(({ name, target }) => [`bystander ${name}`, target]),
    ['outside DNS over TCP', '8.8.8.8:53'],
    ['outside DNS over TCP', '1.1.1.1:53'],
  ];
  for (const [label, target] of blocked) await expectTcpBlocked(label, target);
  await expectUdpDnsBlocked('8.8.8.8');
  await expectUdpDnsBlocked('1.1.1.1');
}

async function controlMode() {
  const backendSvc = required('BACKEND_SVC');
  const backendPod = required('BACKEND_POD_IP');
  const mainPort = required('MAIN_PORT');
  const resultsPort = required('RESULTS_PORT');
  const apiServer = required('API_SERVER');

  // The forbidden targets of job mode answer from here, so job mode's
  // "blocked" lines come from the debug-it-job policy, not a dead network.
  await expectTcpOpen('GitHub', 'github.com:443');
  await expectTcpOpen('GitHub API', 'api.github.com:443');
  await expectTcpOpen('Kubernetes API (endpoint)', apiServer);
  await expectUdpDnsAnswers('8.8.8.8');
  for (const { name, target } of bystanders()) await expectHttpAnswers(`bystander ${name}`, `http://${target}/`);
  for (const [label, target] of [
    ['backend main port (Service)', `${backendSvc}:${mainPort}`],
    ['backend main port (pod)', `${backendPod}:${mainPort}`],
    ['backend results port (Service)', `${backendSvc}:${resultsPort}`],
    ['backend results port (pod)', `${backendPod}:${resultsPort}`],
  ]) {
    await expectTcpBlocked(label, target);
  }
}

if (mode === 'job') await jobMode();
else if (mode === 'control') await controlMode();
else {
  console.log(`FAIL - probe: PROBE_MODE must be job or control`);
  process.exit(1);
}
console.log(`# probe ${mode}: ${failed === 0 ? 'all passed' : `${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
