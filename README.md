# AI Studio ZIP → APK Converter

A private web app that accepts a Google AI Studio project ZIP, builds its web output, wraps it with Capacitor 7, and produces a debug Android APK.

## Architecture

- **Railway:** Express API, temporary build workspace, Node/npm, Android SDK, Java 17 and Gradle.
- **Supabase Auth:** email/password accounts and API-session validation.
- **Supabase Postgres:** per-user conversion history (`public.conversion_jobs`).
- **Supabase Storage:** private `apk-artifacts` bucket. APK objects are stored under `{user_id}/{job_id}/app.apk` and served through one-hour signed URLs.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `PORT` (provided by Railway)
- Optional: `MAX_UPLOAD_BYTES` (default 100 MiB), `BUILD_TIMEOUT_MS` (default 20 minutes)

The publishable key is designed to be exposed in the browser. Never put a Supabase secret/service-role key in frontend code or in the build subprocess environment.

## Supabase setup

The project migration creates:

- `public.conversion_jobs` with row-level security enabled.
- A private `apk-artifacts` Storage bucket (100 MiB per object).
- User-scoped row and object policies.

Enable Email in Supabase Authentication. If email confirmation is enabled, users must confirm their address before signing in. Configure the allowed redirect/site URL in Supabase Auth for the deployed Railway domain.

## Build and run

```bash
npm install
npm start
```

The Dockerfile installs Java 17 and Android SDK platforms/build-tools, then runs the Express server as the unprivileged `node` user. `/health` is the public health-check endpoint.

## Input expectations and limitations

- ZIP must contain a web app with `package.json` and a `build` script, or a static `index.html` project.
- Vite projects are patched to use a relative asset base for Capacitor.
- Build output is expected in `dist/`, `build/`, or `www/`.
- The generated APK is a debug-signed APK, not a Play Store release bundle.
- User-provided npm install/build scripts execute during conversion. This is not a hardened public multi-tenant build sandbox. Keep access restricted to trusted users until builds run in isolated ephemeral workers with strict resource and network controls.
