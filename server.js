
import express from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_ACTIONS_TOKEN;
const GITHUB_REPO = 'manhalkaruthon-pixel/ai-studio-apk-converter';

if (!SUPABASE_URL || !SUPABASE_KEY || !GITHUB_TOKEN) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));

app.use(express.json({ limit: '32kb' }));

app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: '1h'
}));

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

function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Create a job after the browser has uploaded the ZIP directly to Supabase.
app.post('/api/convert', requireUser, async (req, res) => {
  const { jobId, originalFilename, sourceBytes } = req.body || {};

  if (
    typeof jobId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(jobId) ||
    typeof originalFilename !== 'string' ||
    !originalFilename.toLowerCase().endsWith('.zip') ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 1
  ) {
    return res.status(400).json({ error: 'Invalid conversion details.' });
  }

  const userId = req.user.id;
  const sourcePath = `${userId}/${jobId}/source.zip`;
  const artifactPath = `${userId}/${jobId}/app.apk`;

  try {
    // Verify that the ZIP was uploaded before creating the build job.
    const fileCheck = await fetch(
      `${SUPABASE_URL}/storage/v1/object/info/apk-artifacts/${encodePath(sourcePath)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${req.accessToken}`
        }
      }
    );

    if (!fileCheck.ok) {
      return res.status(400).json({
        error: 'The ZIP upload could not be verified. Please try uploading again.'
      });
    }

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
        original_filename: originalFilename,
        status: 'queued',
        source_bytes: sourceBytes
      })
    });

    // Start the GitHub Actions workflow.
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

      await supabaseRequest(
        `/rest/v1/conversion_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(userId)}`,
        req.accessToken,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            status: 'failed',
            error_message: `GitHub workflow could not be started (${dispatch.status}): ${detail.slice(0, 500)}`
          })
        }
      );

      throw new Error(`GitHub workflow could not be started (${dispatch.status}).`);
    }

    return res.status(202).json({
      jobId,
      status: 'queued',
      message: 'Your APK build has been queued.'
    });

  } catch (err) {
    console.error('Job creation failed:', err.message);

    return res.status(502).json({
      error: err.message || 'Could not start the APK build.'
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`APK converter listening on port ${PORT}`);
});
