
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_ACTIONS_TOKEN;
const GITHUB_REPO = 'manhalkaruthon-pixel/ai-studio-apk-converter';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);

if (!SUPABASE_URL || !SUPABASE_KEY || !GITHUB_TOKEN) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.originalname.toLowerCase().endsWith('.zip') &&
      ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype);

    cb(ok ? null : new Error('Upload a .zip archive.'), ok);
  }
});

function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
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
    throw new Error(
      data?.message || data?.error || data?.msg ||
      `Supabase request failed (${response.status}).`
    );
  }

  return data;
}

async function requireUser(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${match[1]}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({
        error: 'Your session has expired. Sign in again.'
      });
    }

    const user = await response.json();

    if (!user?.id) {
      return res.status(401).json({ error: 'Invalid user session.' });
    }

    req.user = user;
    req.accessToken = match[1];
    next();
  } catch {
    return res.status(503).json({
      error: 'Authentication service is temporarily unavailable.'
    });
  }
}

async function updateJob(jobId, userId, accessToken, values) {
  return supabaseRequest(
    `/rest/v1/conversion_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(userId)}`,
    accessToken,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        ...values,
        updated_at: new Date().toISOString()
      })
    }
  );
}

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: '1h'
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Upload ZIP, create job, and ask GitHub Actions to build the APK.
app.post('/api/convert', requireUser, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Select a ZIP archive.' });
  }

  const jobId = crypto.randomUUID();
  const userId = req.user.id;

  const sourcePath = `${userId}/${jobId}/source.zip`;
  const artifactPath = `${userId}/${jobId}/app.apk`;

  let jobCreated = false;

  try {
    // Create the conversion job.
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
        status: 'queued',
        source_bytes: req.file.size
      })
    });

    jobCreated = true;

    // Upload the original ZIP to private Supabase storage.
    await supabaseRequest(
      `/storage/v1/object/apk-artifacts/${encodePath(sourcePath)}`,
      req.accessToken,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'x-upsert': 'false'
        },
        body: req.file.buffer
      }
    );

    // Trigger the GitHub Actions workflow.
    const dispatch = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/android-build.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            job_id: jobId,
            source_path: sourcePath,
            artifact_path: artifactPath
          }
        })
      }
    );

    if (!dispatch.ok) {
      const detail = await dispatch.text();
      throw new Error(`GitHub workflow could not be started (${dispatch.status}): ${detail.slice(0, 500)}`);
    }

    // The actual build now runs on GitHub, not Railway.
    return res.status(202).json({
      jobId,
      status: 'queued',
      message: 'Your APK build has been queued.'
    });

  } catch (err) {
    console.error('Job creation failed:', err.message);

    if (jobCreated) {
      try {
        await updateJob(jobId, userId, req.accessToken, {
          status: 'failed',
          error_message: err.message.slice(0, 1000)
        });
      } catch (dbError) {
        console.error('Could not update failed job:', dbError.message);
      }
    }

    return res.status(502).json({
      error: err.message.slice(0, 1000) || 'Could not start the APK build.',
      jobId: jobCreated ? jobId : undefined
    });
  }
});

// Get a signed download link for a completed APK.
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

    const signed = await supabaseRequest(
      `/storage/v1/object/sign/apk-artifacts/${encodePath(job.artifact_path)}`,
      req.accessToken,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    return res.json({
      downloadUrl: `${SUPABASE_URL}/storage/v1${signed.signedURL}`,
      expiresIn: 3600
    });

  } catch (err) {
    console.error('Download link error:', err.message);
    return res.status(502).json({
      error: 'Could not create the download link. Please try again.'
    });
  }
});

// List the signed-in user's recent conversions.
app.get('/api/jobs', requireUser, async (req, res) => {
  try {
    const rows = await supabaseRequest(
      '/rest/v1/conversion_jobs?select=id,original_filename,status,error_message,artifact_bytes,created_at,completed_at&order=created_at.desc&limit=30',
      req.accessToken
    );

    return res.json({ jobs: rows || [] });

  } catch (err) {
    console.error('Job list error:', err.message);
    return res.status(502).json({ error: 'Could not load your conversions.' });
  }
});

app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError ? 413 : 400;
  res.status(status).json({
    error: err.message || 'Request failed.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`APK converter listening on port ${PORT}`);
});
