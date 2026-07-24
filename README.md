# Agency Invoicer — cloud edition

This version keeps your invoice history in Supabase, so the same account works on your phone and computer.

## 1. Create the tables

In Supabase, open **SQL Editor**, create a new query, paste the complete contents of `supabase-schema.sql`, and run it.

## 2. Enable sign-in links

Under **Authentication → Providers → Email**, enable Email and make sure **Magic Link** is available.

After the first Vercel deployment, go to **Authentication → URL Configuration** and set:

- **Site URL:** your Vercel URL with a trailing slash, for example `https://agency-invoice.vercel.app/`
- **Redirect URLs:** that exact same URL. Add `https://*-<your-vercel-team>.vercel.app/**` too if you use Vercel preview deployments.

## 3. Deploy to Vercel

From the Vercel dashboard, choose **Add New → Project**, then upload or import this folder. Vercel will detect it as a static site automatically — no build command is required.

Open the resulting URL on your computer and phone, then create an account with an email address and password. Sign in with the same account on both devices to share invoice history securely.

Your session stays signed in on each device. If it ever expires, the email address is prefilled; users simply enter their password. The **Forgot or need to set a password?** option also lets existing magic-link users create their first password.

## Notes

- `js/config.js` contains only the Supabase publishable key. It is designed to be public and is protected by the row-level security rules in the supplied schema.
- New and edited invoices are written to the cloud and remain cached on the device for convenience.
- Existing invoices stored only in the previous local browser copy must be brought over once before switching devices. Open the previous app on your computer first, then use the same deployed app thereafter for all new work.
