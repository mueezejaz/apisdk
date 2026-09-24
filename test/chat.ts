import 'dotenv/config';
import * as readline from 'readline';
import { generateText, tool, isStepCount } from 'ai';
import { createGeminiLB, type GeminiLBProvider, type KeyStats, type RequestLog } from 'gemini-lb';
import { z } from 'zod';
import * as cheerio from 'cheerio';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://lms.uaf.edu.pk/course/uaf_student_result.php';
const LOGIN_URL = 'https://lms.uaf.edu.pk/login/index.php';

type QpEntry = [number, number];
type QpTable = Record<number, QpEntry[]>;

function buildQpTable(): QpTable {
  const table: QpTable = {};
  const t20: QpEntry[] = [
    [8, 1], [9, 1.5], [10, 2], [11, 2.33], [12, 2.67], [13, 3], [14, 3.33], [15, 3.67],
  ];
  for (let m = 16; m <= 20; m++) t20.push([m, 4.0]);
  table[20] = t20;
  const t40: QpEntry[] = [
    [16, 2], [17, 2.5], [18, 3], [19, 3.5], [20, 4], [21, 4.33], [22, 4.67], [23, 5],
    [24, 5.33], [25, 5.67], [26, 6], [27, 6.33], [28, 6.67], [29, 7], [30, 7.33], [31, 7.67],
  ];
  for (let m = 32; m <= 40; m++) t40.push([m, 8.0]);
  table[40] = t40;
  const t60: QpEntry[] = [
    [24, 3], [25, 3.5], [26, 4], [27, 4.5], [28, 5], [29, 5.5], [30, 6], [31, 6.33],
    [32, 6.67], [33, 7], [34, 7.33], [35, 7.67], [36, 8], [37, 8.33], [38, 8.67],
    [39, 9], [40, 9.33], [41, 9.67], [42, 10], [43, 10.33], [44, 10.67], [45, 11], [46, 11.33], [47, 11.67],
  ];
  for (let m = 48; m <= 60; m++) t60.push([m, 12.0]);
  table[60] = t60;
  const t80: QpEntry[] = [
    [32, 4], [33, 4.5], [34, 5], [35, 5.5], [36, 6], [37, 6.5], [38, 7], [39, 7.5],
    [40, 8], [41, 8.33], [42, 8.67], [43, 9], [44, 9.33], [45, 9.67], [46, 10],
    [47, 10.33], [48, 10.67], [49, 11], [50, 11.33], [51, 11.67], [52, 12], [53, 12.33],
    [54, 12.67], [55, 13], [56, 13.33], [57, 13.67], [58, 14], [59, 14.33], [60, 14.67],
    [61, 15], [62, 15.33], [63, 15.67],
  ];
  for (let m = 64; m <= 80; m++) t80.push([m, 16.0]);
  table[80] = t80;
  const t100: QpEntry[] = [
    [40, 5], [41, 5.5], [42, 6], [43, 6.5], [44, 7], [45, 7.5], [46, 8], [47, 8.5],
    [48, 9], [49, 9.5], [50, 10], [51, 10.33], [52, 10.67], [53, 11], [54, 11.33],
    [55, 11.67], [56, 12], [57, 12.33], [58, 12.67], [59, 13], [60, 13.33], [61, 13.67],
    [62, 14], [63, 14.33], [64, 14.67], [65, 15], [66, 15.33], [67, 15.67], [68, 16],
    [69, 16.33], [70, 16.67], [71, 17], [72, 17.33], [73, 17.67], [74, 18], [75, 18.33],
    [76, 18.67], [77, 19], [78, 19.33], [79, 19.67],
  ];
  for (let m = 80; m <= 100; m++) t100.push([m, 20.0]);
  table[100] = t100;
  return table;
}

const QP_TABLE = buildQpTable();

function getGradeFromPct(pct: number): string {
  if (pct >= 80) return 'A';
  if (pct >= 65) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 40) return 'D';
  return 'F';
}

function getQp(obtained: number, maxMarks: number): number {
  const supported = [20, 40, 60, 80, 100];
  const nearest = supported.reduce((prev, curr) =>
    Math.abs(curr - maxMarks) < Math.abs(prev - maxMarks) ? curr : prev
  );
  const entries = QP_TABLE[nearest] ?? [];
  let qp = 0.0;
  for (const [mark, points] of entries) {
    if (obtained >= mark) qp = points;
  }
  return qp;
}

function getGradeFromQp(obtained: number, maxMarks: number): string {
  if (maxMarks <= 0) return 'F';
  return getGradeFromPct((obtained / maxMarks) * 100);
}

function parseCredits(ch: string): number {
  const m = String(ch).trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function parseFloat_(val: string | undefined): number | null {
  if (val === undefined || val === null) return null;
  const n = parseFloat(String(val).trim());
  return isNaN(n) ? null : n;
}

function semesterSortKey(semName: string): [number, number] {
  const lower = semName.toLowerCase();
  const season = lower.includes('spring') ? 1 : lower.includes('fall') ? 2 : 0;
  const rangeMatch = semName.match(/(\d{4})-(\d{2,4})/);
  let year = 0;
  if (rangeMatch) {
    const startYear = parseInt(rangeMatch[1], 10);
    const endPart = rangeMatch[2];
    year = endPart.length === 2
      ? parseInt(String(startYear).slice(0, 2) + endPart, 10)
      : parseInt(endPart, 10);
  } else {
    const single = semName.match(/(\d{4})/);
    year = single ? parseInt(single[1], 10) : 0;
  }
  return [year, season];
}

function buildCookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getToken(cookieJar: Map<string, string>): Promise<{ token: string; moodleSession: string }> {
  const resp = await fetch(LOGIN_URL, { method: 'GET', redirect: 'follow' });
  if (!resp.ok) throw new Error(`Login page fetch failed: ${resp.status}`);

  const setCookie = resp.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) {
    const [pair] = cookie.split(';');
    const [key, value] = pair.split('=');
    if (key && value) cookieJar.set(key.trim(), value.trim());
  }

  const html = await resp.text();
  const tokenMatch =
    html.match(/document\.getElementById\(['"](logintoken|token)['"]\)\.value\s*=\s*['"]([a-f0-9]+)['"]/) ??
    html.match(/name="logintoken"\s+value="([a-f0-9]+)"/) ??
    html.match(/<input[^>]+name="logintoken"[^>]+value="([a-f0-9]+)"/) ??
    html.match(/value="([a-f0-9]{32,})"/);

  if (!tokenMatch) throw new Error('Token not found on login page');
  const token = tokenMatch[tokenMatch.length - 1];
  const moodleSession = cookieJar.get('MoodleSession');
  if (!moodleSession) throw new Error('MoodleSession cookie missing');
  return { token, moodleSession };
}

async function fetchResultHtml(register: string, token: string, cookieJar: Map<string, string>): Promise<string> {
  const body = new URLSearchParams({ token, Register: register });
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: LOGIN_URL,
      Cookie: buildCookieHeader(cookieJar),
    },
    body: body.toString(),
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error(`Result fetch failed: ${resp.status}`);
  return resp.text();
}

type CourseRow = Record<string, string> & {
  _excluded?: boolean;
  _repeat_note?: string;
  _computed_grade?: string;
  _qp?: number;
};

function parseHtml(html: string): { studentInfo: Record<string, string>; courses: CourseRow[] } {
  const $ = cheerio.load(html);
  const studentInfo: Record<string, string> = {};
  const courses: CourseRow[] = [];

  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    if (rows.length < 2) return;

    const headers = $(rows[0])
      .find('th, td')
      .toArray()
      .map((el) => $(el).text().trim());

    if (headers.includes('Grade') || headers.includes('Course Code')) {
      rows.slice(1).forEach((row) => {
        const cells = $(row).find('th, td').toArray().map((el) => $(el).text().trim());
        if (!cells.some(Boolean)) return;
        while (cells.length < headers.length) cells.push('');
        const entry: CourseRow = {};
        headers.forEach((h, i) => (entry[h] = cells[i] ?? ''));
        courses.push(entry);
      });
    } else if (headers.length === 2) {
      rows.forEach((row) => {
        const cells = $(row).find('th, td').toArray().map((el) => $(el).text().trim());
        if (cells.length === 2) studentInfo[cells[0]] = cells[1];
      });
    }
  });

  return { studentInfo, courses };
}

function calculateGpas(courses: CourseRow[]): {
  semGpas: Record<string, number>;
  cgpa: number;
  totalCr: number;
} {
  const codeAttempts = new Map<string, number[]>();
  courses.forEach((c, i) => {
    const code = (c['Course Code'] ?? '').trim();
    if (!code) return;
    if (!codeAttempts.has(code)) codeAttempts.set(code, []);
    codeAttempts.get(code)!.push(i);
  });

  const excludedIndices = new Set<number>();
  for (const [, indices] of codeAttempts) {
    if (indices.length < 2) continue;
    indices.slice(0, -1).forEach((idx) => {
      const grade = (courses[idx]['Grade'] ?? '').trim();
      if (grade === 'F' || grade === 'D' || grade === '') {
        courses[idx]._excluded = true;
        courses[idx]._repeat_note = 'Repeated in a later semester';
        excludedIndices.add(idx);
      }
    });
  }

  const semData = new Map<string, { qp: number; cr: number }>();
  let totalQp = 0.0;
  let totalCr = 0;

  courses.forEach((c, i) => {
    const cr = parseCredits(c['Credit Hours'] ?? '0');
    if (cr === 0) return;

    const existingGrade = (c['Grade'] ?? '').trim().toUpperCase();
    if (existingGrade === 'P') { c._computed_grade = 'P'; c._qp = 0.0; return; }
    if (existingGrade === 'F') {
      c._computed_grade = 'F'; c._qp = 0.0;
      if (!excludedIndices.has(i)) {
        const sem = c['Semester'];
        if (!semData.has(sem)) semData.set(sem, { qp: 0, cr: 0 });
        semData.get(sem)!.cr += cr;
        totalCr += cr;
      }
      return;
    }

    const maxMarks = cr * 20;
    let obtained = parseFloat_(c['Total'] ?? '');
    if (obtained === null) {
      const mid = parseFloat_(c['Mid']) ?? 0;
      const asgn = parseFloat_(c['Assignment']) ?? 0;
      const final = parseFloat_(c['Final']) ?? 0;
      const prac = parseFloat_(c['Practical']) ?? 0;
      obtained = mid + asgn + final + prac;
    }
    if (obtained <= 0) return;

    const qp = getQp(obtained, maxMarks);
    const grade = getGradeFromQp(obtained, maxMarks);
    c._computed_grade = grade;
    c._qp = qp;

    if (excludedIndices.has(i)) return;

    const sem = c['Semester'];
    if (!semData.has(sem)) semData.set(sem, { qp: 0, cr: 0 });
    semData.get(sem)!.qp += qp;
    semData.get(sem)!.cr += cr;
    totalQp += qp;
    totalCr += cr;
  });

  const semGpas: Record<string, number> = {};
  for (const [sem, d] of semData) {
    if (d.cr > 0) semGpas[sem] = Math.round((d.qp / d.cr) * 100) / 100;
  }
  const cgpa = totalCr > 0 ? Math.round((totalQp / totalCr) * 100) / 100 : 0.0;
  return { semGpas, cgpa, totalCr };
}

async function fetchUafResult(register: string) {
  const cookieJar = new Map<string, string>();
  const { token, moodleSession } = await getToken(cookieJar);
  cookieJar.set('MoodleSession', moodleSession);

  const html = await fetchResultHtml(register, token, cookieJar);
  const { studentInfo, courses } = parseHtml(html);

  if (courses.length === 0) {
    return { error: 'No result found for this registration number' };
  }

  const { semGpas, cgpa, totalCr } = calculateGpas(courses);

  const semesterOrder = [...new Map(courses.map((c) => [c['Semester'], true])).keys()];
  semesterOrder.sort((a, b) => {
    const [ay, as_] = semesterSortKey(a);
    const [by, bs] = semesterSortKey(b);
    return by !== ay ? by - ay : bs - as_;
  });

  const semesterList = semesterOrder.map((sem) => ({
    name: sem,
    gpa: semGpas[sem] ?? 0,
    courses: courses
      .filter((c) => c['Semester'] === sem)
      .map((c) => ({
        code: c['Course Code'] ?? '',
        title: c['Course Title'] ?? '',
        credits: c['Credit Hours'] ?? '',
        total: c['Total'] ?? '',
        grade: (c['Grade'] ?? '').trim() || (c._computed_grade ?? ''),
        qp: Math.round((c._qp ?? 0) * 100) / 100,
        excluded: c._excluded ?? false,
      })),
  }));

  return { student_info: studentInfo, semesters: semesterList, cgpa, total_credit_hours: totalCr };
}

// ─── Tools ────────────────────────────────────────────────────────────────

const weatherTool = tool({
  description: 'Get the current weather for a city',
  inputSchema: z.object({
    city: z.string().describe('The city name'),
  }),
  execute: async ({ city }) => {
    const weathers: Record<string, { temp: number; condition: string; humidity: number }> = {
      'new york': { temp: 72, condition: 'Sunny', humidity: 45 },
      'london': { temp: 58, condition: 'Cloudy', humidity: 78 },
      'tokyo': { temp: 80, condition: 'Humid', humidity: 85 },
      'paris': { temp: 65, condition: 'Partly Cloudy', humidity: 60 },
      'dubai': { temp: 105, condition: 'Hot & Clear', humidity: 20 },
      'mumbai': { temp: 88, condition: 'Monsoon', humidity: 92 },
      'sydney': { temp: 68, condition: 'Windy', humidity: 55 },
      'berlin': { temp: 55, condition: 'Rainy', humidity: 70 },
    };
    const key = city.toLowerCase();
    const data = weathers[key] ?? { temp: 70 + Math.floor(Math.random() * 20), condition: 'Clear', humidity: 50 };
    return { city, ...data, unit: 'fahrenheit' };
  },
});

const uafResultTool = tool({
  description: 'Fetch a UAF student result by registration number (format: YYYY-AG-XXXX, e.g. 2022-ag-1234)',
  inputSchema: z.object({
    registerNumber: z.string().describe('The UAF registration number in format YYYY-AG-XXXX'),
  }),
  execute: async ({ registerNumber }) => {
    return fetchUafResult(registerNumber);
  },
});

const tools = { get_weather: weatherTool, fetch_uaf_result: uafResultTool };

// ─── Chat App ─────────────────────────────────────────────────────────────

// Everything (keys, providers, base URLs, models, and per-model limits) lives
// in Redis — manage it in the dashboard (`npm run dashboard`).
if (!process.env.REDIS_URL) {
  console.error('\n  ❌ REDIS_URL is not set. Add it to your .env file.\n');
  process.exit(1);
}

const lb: GeminiLBProvider = createGeminiLB({
  redisUrl: process.env.REDIS_URL,
});

const DEFAULT_DISPLAY_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'th-orchestra',
];
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google Gemini',
  tokenharbor: 'Token Harbor',
};
let activeModel = 'auto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function printHelp() {
  console.log(`
Available commands:
  /models          - List configured models and providers
  /model <id>      - Set model (use "auto" for automatic selection)
  /usage           - Show rate limiter stats
  /log             - Show recent request log
  /raw <prompt>    - Direct provider call using the active model
  /clear           - Clear screen
  /help            - Show this help
  /exit            - Quit

  Or just type anything to chat with the active model.
  Current model: ${activeModel}
`);
}

function printStats(stats: KeyStats[]) {
  console.log('\n── Rate Limiter Stats ──');
  for (const s of stats) {
    const minBar = '█'.repeat(s.minuteUsed) + '░'.repeat(s.minuteRemaining);
    const dayBar = '█'.repeat(Math.min(s.dayUsed, 20)) + '░'.repeat(Math.min(s.dayRemaining, 20));
    console.log(`  Key ${s.keyIndex} (${s.maskedKey}) | ${PROVIDER_LABELS[s.provider] ?? s.provider} | ${s.model}`);
    if (s.baseUrl) console.log(`    base URL: ${s.baseUrl}`);
    console.log(`    1-min: [${minBar}] ${s.minuteUsed}/${s.minuteUsed + s.minuteRemaining}`);
    console.log(`    daily: [${dayBar}] ${s.dayUsed}/${s.dayUsed + s.dayRemaining}`);
  }
  console.log('');
}

function printLog(log: RequestLog[]) {
  console.log('\n── Request Log (last 20) ──');
  const recent = log.slice(-20);
  if (recent.length === 0) {
    console.log('  No requests yet.');
  }
  for (const entry of recent) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const icon = entry.action === 'claimed' ? '✓' : entry.action === 'released' ? '✗' : '⚠';
    console.log(`  ${icon} ${time} | Key ${entry.keyIndex} (${entry.maskedKey}) | ${entry.model}`);
  }
  console.log('');
}

function startSpinner(): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} Thinking...   `);
  }, 80);
  return () => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
  };
}

async function handleChat(input: string) {
  const stop = startSpinner();

  try {
    const { text, toolResults } = await generateText({
      model: lb(activeModel),
      prompt: input,
      tools,
      stopWhen: isStepCount(5),
    });
    stop();

    if (toolResults && toolResults.length > 0) {
      for (const tr of toolResults) {
        const output = tr.output as any;
        if (tr.toolName === 'get_weather') {
          console.log(`\n  ⚡ get_weather(${output.city}): ${output.temp}°F, ${output.condition}, ${output.humidity}% humidity`);
        }
        if (tr.toolName === 'fetch_uaf_result') {
          if (output.error) {
            console.log(`\n  ❌ ${output.error}`);
          } else {
            console.log(`\n  📋 Result for ${output.student_info?.['Name'] ?? 'Unknown'} (${output.student_info?.['Register No'] ?? ''})`);
            console.log(`  CGPA: ${output.cgpa} | Total Credits: ${output.total_credit_hours}`);
            for (const sem of output.semesters ?? []) {
              console.log(`\n  ── ${sem.name} (GPA: ${sem.gpa}) ──`);
              for (const c of sem.courses) {
                const flag = c.excluded ? ' [excluded]' : '';
                console.log(`    ${c.code} | ${c.title} | ${c.credits}cr | ${c.total} | ${c.grade} | QP: ${c.qp}${flag}`);
              }
            }
          }
        }
      }
      console.log('');
    }

    console.log(`${text}\n`);
  } catch (error: any) {
    stop();
    console.error(`\n  Error: ${error.message}\n`);
  }
}

/** Direct Google/Token Harbor API call through the package's raw client. */
async function handleRaw(promptText: string) {
  if (!promptText) {
    console.log('\n  Usage: /raw <your prompt>  — direct provider call via lb.generate()\n');
    return;
  }
  const stop = startSpinner();
  try {
    const res = await lb.generate({ model: activeModel, prompt: promptText });
    stop();
    console.log(`\n${res.text}`);
    console.log(`\n  ⚡ raw call · provider=${res.provider} · model=${res.model} · key=${res.keyId}\n`);
  } catch (error: any) {
    stop();
    console.error(`\n  Error: ${error.message}\n`);
  }
}

type ModelCatalogEntry = {
  id: string;
  providers: Set<string>;
  baseUrls: Set<string>;
};

async function getModelCatalog(): Promise<ModelCatalogEntry[]> {
  const catalog = new Map<string, ModelCatalogEntry>();
  try {
    const keys = await lb.getKeyStore().list();
    for (const key of keys) {
      if (!key.enabled) continue;
      const provider = key.provider ?? 'google';
      const fallbackIds = provider === 'tokenharbor'
        ? ['th-orchestra']
        : DEFAULT_DISPLAY_MODELS.filter((id) => id.startsWith('gemini-'));
      const models = key.models.length > 0
        ? key.models
        : fallbackIds.map((id) => ({ id, maxPerMinute: 0, maxPerDay: 0 }));
      for (const model of models) {
        const entry = catalog.get(model.id) ?? {
          id: model.id,
          providers: new Set<string>(),
          baseUrls: new Set<string>(),
        };
        entry.providers.add(provider);
        if (key.baseUrl) entry.baseUrls.add(key.baseUrl);
        catalog.set(model.id, entry);
      }
    }
  } catch {
    // Redis unreachable — the request itself will report the connection error.
  }

  if (catalog.size === 0) {
    for (const id of DEFAULT_DISPLAY_MODELS) {
      catalog.set(id, { id, providers: new Set(), baseUrls: new Set() });
    }
  }
  return [...catalog.values()];
}

async function printModels(): Promise<void> {
  const catalog = await getModelCatalog();
  console.log('\n── Configured Models ──');
  for (const model of catalog) {
    const providers = model.providers.size > 0
      ? [...model.providers].map((p) => PROVIDER_LABELS[p] ?? p).join(', ')
      : 'not configured';
    console.log(`  ${model.id}  [${providers}]`);
    for (const baseUrl of model.baseUrls) console.log(`    ${baseUrl}`);
  }
  console.log(`\n  Active model: ${activeModel}`);
  console.log('  Use /model <id> or /model auto.\n');
}

async function printBanner() {
  let keyCount = 0;
  const catalog = await getModelCatalog();
  const providerNames = new Set<string>();

  try {
    const keys = await lb.getKeyStore().list();
    keyCount = keys.filter((key) => key.enabled).length;
    for (const key of keys) {
      if (key.enabled) providerNames.add(key.provider ?? 'google');
    }
  } catch {
    // Redis unreachable — show defaults, requests will fail later anyway
  }

  const enabled = keyCount === 0
    ? '⚠ no enabled keys in Redis — add one in the dashboard'
    : `${keyCount} key${keyCount === 1 ? '' : 's'} · ${catalog.length} model${catalog.length === 1 ? '' : 's'} · ${[...providerNames].map((p) => PROVIDER_LABELS[p] ?? p).join(' + ') || 'provider unknown'}`;

  console.log('\x1b[1m');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       AI Load-Balanced Chat           ║');
  const enabledLine = `  ║  ${enabled}`.slice(0, 44).padEnd(44, ' ');
  console.log(enabledLine + '║');
  console.log(`  ║  Active model: ${activeModel}`.padEnd(44) + '║');
  console.log('  ║  Tools: weather, UAF results         ║');
  console.log('  ║  Type /help for commands             ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('\x1b[0m');
}

function ask(): void {
  process.stdout.write('\x1b[36myou ❯\x1b[0m ');
}

async function handleLine(rawLine: string): Promise<void> {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  const cmd = trimmed.toLowerCase();
  if (cmd === '/exit' || cmd === '/quit') {
    console.log('\nBye!\n');
    await lb.disconnect();
    rl.close();
    process.exit(0);
  }

  if (cmd === '/usage' || cmd === '/stats') {
    printStats(await lb.getStats());
  } else if (cmd === '/models' || cmd === '/providers') {
    await printModels();
  } else if (cmd === '/model' || cmd.startsWith('/model ')) {
    const requested = trimmed.replace(/^\/model\s*/i, '').trim();
    if (!requested) {
      console.log(`\n  Active model: ${activeModel}\n`);
    } else {
      const catalog = await getModelCatalog();
      if (requested !== 'auto' && !catalog.some((model) => model.id === requested)) {
        console.log(`\n  Model "${requested}" is not configured. Use /models to see available models.\n`);
      } else {
        activeModel = requested;
        console.log(`\n  Active model: ${activeModel}\n`);
      }
    }
  } else if (cmd === '/log') {
    printLog(lb.getRequestLog());
  } else if (cmd === '/clear') {
    console.clear();
  } else if (cmd === '/help') {
    printHelp();
  } else if (cmd === '/raw' || cmd.startsWith('/raw ')) {
    await handleRaw(trimmed.replace(/^\/raw\s*/i, ''));
  } else if (trimmed.startsWith('/')) {
    console.log(`\n  Unknown command: ${trimmed}. Type /help for options.\n`);
  } else {
    await handleChat(trimmed);
  }
}

async function runChat(): Promise<void> {
  await printBanner();
  ask();
  // Async-iterator loop: buffers piped input and ends cleanly on stdin EOF
  // (the old recursive rl.question crashed with ERR_USE_AFTER_CLOSE there).
  for await (const line of rl) {
    await handleLine(line);
    ask();
  }
  await lb.disconnect();
  process.exit(0);
}

runChat().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
