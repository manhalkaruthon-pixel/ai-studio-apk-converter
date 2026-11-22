
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import unzipper from 'unzipper';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT_MS || 20 * 60 * 1000);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be configured.');
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.zip') &&
      ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype);
    cb(ok ? null : new Error('Upload a .zip archive.'), ok);
  }
});

async function requireUser(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Sign in to continue.' });

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` }
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }

    const user = await response.json();
    if (!user?.id) return res.status(401).json({ error: 'Invalid user session.' });

    req.user = user;
    req.accessToken = match[1];
    next();
  } catch {
    return res.status(503).json({ error: 'Authentication service is temporarily unavailable.' });
  }
}

async function supabaseRequest(endpoint, accessToken, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error || data?.msg || `Supabase request failed (${response.status}).`);
  }

  return data;
}

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: '1h'
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

function run(command, args, cwd, timeout = BUILD_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const buildEnv = {
      ...process.env,
      CI: '1',
      ANDROID_HOME: process.env.ANDROID_HOME || '/opt/android-sdk',
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || '/opt/android-sdk'
    };

    delete buildEnv.APP_PASSWORD;
    delete buildEnv.SUPABASE_URL;
    delete buildEnv.SUPABASE_PUBLISHABLE_KEY;

    const child = spawn(command, args, {
      cwd,
      env: buildEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    child.stderr.on('data', d => {
      stderr = (stderr + d.toString()).slice(-12000);
    });

    child.stdout.on('data', () => {});

    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);

      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}. ${stderr.slice(-3000)}`));
    });
  });
}

async function extractSafe(zipPath, destination) {
  await fs.mkdir(destination, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  let total = 0;

  if (directory.files.length > 5000) {
    throw new Error('Archive contains too many files.');
  }

  for (const entry of directory.files) {
    const raw = entry.path.replaceAll('\\', '/');

    if (
      raw.startsWith('/') ||
      /^[A-Za-z]:/.test(raw) ||
      raw.split('/').some(p => p === '..')
    ) {
      throw new Error('Unsafe path in ZIP archive.');
    }

    if (entry.type === 'SymbolicLink') {
      throw new Error('Symbolic links are not allowed in ZIP archives.');
    }

    total += entry.uncompressedSize || 0;

    if (total > 500 * 1024 * 1024) {
      throw new Error('Uncompressed archive exceeds 500 MB.');
    }

    const target = path.resolve(destination, raw);

    if (
      !target.startsWith(path.resolve(destination) + path.sep) &&
      target !== path.resolve(destination)
    ) {
      throw new Error('Unsafe archive path.');
    }

    if (entry.type === 'Directory') {
      await fs.mkdir(target, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });

      await new Promise((resolve, reject) => {
        entry.stream()
          .pipe(createWriteStream(target, { mode: 0o644 }))
          .on('finish', resolve)
          .on('error', reject);
      });
    }
  }
}

// Detect native Android projects and web projects, including nested ZIP folders.
async function findProject(dir, depth = 0) {
  if (depth > 6) return null;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = new Set(entries.filter(e => e.isFile()).map(e => e.name));

  const hasGradleSettings =
    files.has('settings.gradle') || files.has('settings.gradle.kts');

  const hasAppGradle = await Promise.all([
    fs.access(path.join(dir, 'app', 'build.gradle'))
      .then(() => true).catch(() => false),
    fs.access(path.join(dir, 'app', 'build.gradle.kts'))
      .then(() => true).catch(() => false)
  ]).then(results => results.some(Boolean));

  if (hasGradleSettings && hasAppGradle) {
    return { root: dir, type: 'native' };
  }

  if (files.has('package.json') || files.has('index.html')) {
    return { root: dir, type: 'web' };
  }

  const dirs = entries.filter(e =>
    e.isDirectory() &&
    !['node_modules', '__MACOSX', '.git', 'build'].includes(e.name)
  );

  for (const entry of dirs) {
    const result = await findProject(path.join(dir, entry.name), depth + 1);
    if (result) return result;
  }

  return null;
}

// Remove environment files but preserve .env.example.
async function removeEnvFiles(root) {
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        if (['node_modules', '.git'].includes(ent.name)) continue;
        await walk(full);
      } else {
        const isEnvFile =
          ent.name === '.env' ||
          (ent.name.startsWith('.env.') && ent.name !== '.env.example');

        if (isEnvFile) {
          await fs.rm(full, { force: true });
        }
      }
    }
  }

  await walk(root);
}

function safeId(value) {
  return String(value || 'app')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48) || 'app';
}

async function patchVite(root) {
  const files = (await fs.readdir(root)).filter(n =>
    /^vite\.config\.(js|mjs|ts|mts|cjs)$/.test(n)
  );

  for (const name of files) {
    const full = path.join(root, name);
    let source = await fs.readFile(full, 'utf8');

    if (/\bbase\s*:/.test(source)) {
      source = source.replace(
        /\bbase\s*:\s*(['"`])[^'"`]*\1/,
        "base: './'"
      );
    } else {
      source = source.replace(
        /defineConfig\s*\(\s*\{/,
        "defineConfig({ base: './',"
      );
    }

    await fs.writeFile(full, source);
  }
}

async function findApk(dir) {
  const matches = [];

  async function walk(current) {
    let entries;

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.apk')
      ) {
        matches.push(full);
      }
    }
  }

  await walk(dir);

  return matches.find(p => p.endsWith('/debug/app-debug.apk')) ||
    matches[0] ||
    null;
}

async function buildNativeAndroid(root) {
  // Generate the standard Android debug signing key if the project does not have one.
  const keystore = path.join(root, 'debug.keystore');

  try {
    await fs.access(keystore);
  } catch {
    await run('keytool', [
      '-genkeypair',
      '-v',
      '-keystore', keystore,
      '-storepass', 'android',
      '-alias', 'androiddebugkey',
      '-keypass', 'android',
      '-keyalg', 'RSA',
      '-keysize', '2048',
      '-validity', '10000',
      '-dname', 'CN=Android Debug,O=Android,C=US'
    ], root);
  }

  // Use the Gradle version installed in the Docker image.
  await run('gradle', [
    'assembleDebug',
    '--no-daemon',
    '--max-workers=1',
    '--no-configuration-cache',
    '-Dorg.gradle.jvmargs=-Xmx384m -XX:MaxMetaspaceSize=192m',
    '-Dorg.gradle.internal.instrumentation.agent=false',
    '-Pkotlin.compiler.execution.strategy=in-process'
  ], root, BUILD_TIMEOUT);

  const apk = await findApk(
    path.join(root, 'app', 'build', 'outputs', 'apk')
  );

  if (!apk) {
    throw new Error('Gradle build finished, but no debug APK was found.');
  }

  return apk;
}

async function buildWebProject(root, work) {
  await patchVite(root);

  const pkgPath = path.join(root, 'package.json');
  let pkg = null;

  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch {}

  const appName = String(pkg?.name || path.basename(root))
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 40) || 'Converted App';

  const appId = `com.aistudio.converted.${safeId(pkg?.name || path.basename(root)).replaceAll('.', '')}`;

  let webDir;

  if (pkg) {
    await run('npm', ['install', '--no-audit', '--no-fund'], root);
    await run('npm', ['run', 'build'], root);

    const candidates = ['dist', 'build', 'www'].map(n =>
      path.join(root, n)
    );

    webDir = null;

    for (const candidate of candidates) {
      try {
        if ((await fs.stat(path.join(candidate, 'index.html'))).isFile()) {
          webDir = candidate;
          break;
        }
      } catch {}
    }

    if (!webDir) {
      throw new Error('Build completed but no dist/, build/ or www/ index.html was produced.');
    }
  } else {
    try {
      await fs.access(path.join(root, 'index.html'));
    } catch {
      throw new Error('ZIP must contain package.json or a root index.html.');
    }

    webDir = path.join(work, 'www');

    await fs.cp(root, webDir, {
      recursive: true,
      filter: src => !src.split(path.sep).some(p =>
        p === '.git' || p === 'node_modules'
      )
    });
  }

  const native = path.join(work, 'native');
  await fs.mkdir(native, { recursive: true });
  await fs.cp(webDir, path.join(native, 'www'), { recursive: true });

  await fs.writeFile(
    path.join(native, 'package.json'),
    JSON.stringify({
      name: 'apk-wrapper',
      version: '1.0.0',
      private: true
    }, null, 2)
  );

  await run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '@capacitor/core@^7',
    '@capacitor/cli@^7',
    '@capacitor/android@^7'
  ], native);

  await fs.writeFile(
    path.join(native, 'capacitor.config.json'),
    JSON.stringify({
      appId,
      appName,
      webDir: 'www',
      bundledWebRuntime: false
    }, null, 2)
  );

  await run('npx', ['cap', 'add', 'android'], native);
  await run('npx', ['cap', 'sync', 'android'], native);

  const androidDir = path.join(native, 'android');

  await run(
    './gradlew',
    ['assembleDebug', '--no-daemon'],
    androidDir,
    BUILD_TIMEOUT
  );

  const apk = await findApk(
    path.join(androidDir, 'app', 'build', 'outputs', 'apk')
  );

  if (!apk) {
    throw new Error('Web build finished, but no APK was found.');
  }

  return { apk, appName };
}

app.post('/api/convert', requireUser, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Select a ZIP archive.' });
  }

  const jobId = crypto.randomUUID();
  const userId = req.user.id;
  const objectPath = `${userId}/${jobId}/app.apk`;
  const work = await fs.mkdtemp(path.join('/var/tmp/apk-build', 'job-'));
  let jobCreated = false;

  try {
    await supabaseRequest('/rest/v1/conversion_jobs', req.accessToken, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        id: jobId,
        user_id: userId,
        original_filename: req.file.originalname,
        status: 'building',
        source_bytes: req.file.size
      })
    });

    jobCreated = true;

    const zipPath = path.join(work, 'source.zip');

    await fs.writeFile(zipPath, req.file.buffer, { mode: 0o600 });

    const extracted = path.join(work, 'extracted');

    await extractSafe(zipPath, extracted);

    const project = await findProject(extracted);

    if (!project) {
      throw new Error('Could not find a valid Android Gradle project or web project in this ZIP.');
    }

    const root = project.root;

    await removeEnvFiles(root);

    let apk;
    let appName;

    if (project.type === 'native') {
      appName = path.basename(root);
      apk = await buildNativeAndroid(root);
    } else {
      const result = await buildWebProject(root, work);
      apk = result.apk;
      appName = result.appName;
    }

    const apkBuffer = await fs.readFile(apk);

    await supabaseRequest(
      `/storage/v1/object/apk-artifacts/${objectPath}`,
      req.accessToken,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'x-upsert': 'false'
        },
        body: apkBuffer
      }
    );

    await supabaseRequest(
      `/rest/v1/conversion_jobs?id=eq.${jobId}&user_id=eq.${userId}`,
      req.accessToken,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          status: 'completed',
          artifact_path: objectPath,
          artifact_bytes: apkBuffer.length,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    );

    const signed = await supabaseRequest(
      `/storage/v1/object/sign/apk-artifacts/${objectPath}`,
      req.accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    if (!res.headersSent) {
      res.json({
        jobId,
        appName,
        downloadUrl: `${SUPABASE_URL}/storage/v1${signed.signedURL}`,
        expiresIn: 3600
      });
    }
  } catch (err) {
    console.error('Conversion failed:', err.message);

    if (jobCreated) {
      try {
        await supabaseRequest(
          `/rest/v1/conversion_jobs?id=eq.${jobId}&user_id=eq.${userId}`,
          req.accessToken,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              status: 'failed',
              error_message: err.message.slice(0, 1000),
              updated_at: new Date().toISOString()
            })
          }
        );
      } catch (dbErr) {
        console.error('Could not update failed job:', dbErr.message);
      }
    }

    if (!res.headersSent) {
      res.status(422).json({
        error: err.message.slice(0, 1200) || 'Conversion failed.',
        jobId: jobCreated ? jobId : undefined
      });
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
});

// Create a fresh private download URL for a completed job owned by the signed-in user.
app.get('/api/jobs/:id/download', requireUser, async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid job ID.' });
    }

    const rows = await supabaseRequest(
      `/rest/v1/conversion_jobs?select=id,status,artifact_path&id=eq.${encodeURIComponent(req.params.id)}&user_id=eq.${encodeURIComponent(req.user.id)}&limit=1`,
      req.accessToken
    );

    const job = rows?.[0];

    if (!job) {
      return res.status(404).json({ error: 'Conversion not found.' });
    }

    if (job.status !== 'completed' || !job.artifact_path) {
      return res.status(409).json({ error: 'APK is not ready yet.' });
    }

    const safePath = String(job.artifact_path)
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const signed = await supabaseRequest(
      `/storage/v1/object/sign/apk-artifacts/${safePath}`,
      req.accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    res.json({
      downloadUrl: `${SUPABASE_URL}/storage/v1${signed.signedURL}`,
      expiresIn: 3600
    });
  } catch (err) {
    console.error('Download link error:', err.message);

    res.status(502).json({
      error: 'Could not create the download link. Please try again.'
    });
  }
});

app.get('/api/jobs', requireUser, async (req, res) => {
  try {
    const rows = await supabaseRequest(
      '/rest/v1/conversion_jobs?select=id,original_filename,status,error_message,artifact_bytes,created_at,completed_at&order=created_at.desc&limit=30',
      req.accessToken
    );

    res.json({ jobs: rows || [] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({ error: err.message || 'Request failed.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`APK converter listening on ${PORT}`);
});
