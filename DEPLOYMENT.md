# Render + Supabase setup

## 1. Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run `supabase-schema.sql`.
3. In **Authentication > Providers**, enable **Google**.
4. In Google Cloud OAuth, add these redirect URIs:
   - `https://YOUR_RENDER_DOMAIN/login`
   - `https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback`
5. In Supabase **Authentication > URL Configuration**, set:
   - Site URL: `https://YOUR_RENDER_DOMAIN`
   - Redirect URL: `https://YOUR_RENDER_DOMAIN/login`

## 2. Render

Create a **Web Service** and use:

- Build Command: `npm install`
- Start Command: `npm start`

Set these environment variables:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `PORT` is provided automatically by Render.

`SUPABASE_SERVICE_ROLE_KEY` must stay server-only. Do not put it in browser code.

## 3. Local development

Without Supabase environment variables, the app keeps using local `bookmarks.db`.

```bash
npm install
npm start
```

Open `http://localhost:3000/login`.
